import { Injectable, Logger } from '@nestjs/common';
import type {
  Citation,
  ComposerResult,
  DraftFn,
  DraftVerification,
  UnresolvedMarker,
} from './composer.types.js';

/**
 * WS-4 Composer — the citation gate as a runtime component, not a prompt
 * (V2_AI_AGENT_PLATFORM.md §3.5). The LLM is allowed to be sloppy; the
 * system is not.
 *
 * Draft format contract: the LLM emits inline markers
 *   `[claim text](cite:<citationId>)`
 * where <citationId> must be the id of a citation returned by a capability
 * call in THIS plan. This service verifies marker integrity (fabricated
 * citation ids, uncited declarative sentences), re-asks with structured
 * feedback (bounded, default 2), and after retries are exhausted strips the
 * still-offending sentences and reports them in `removedClaims` so the
 * caller can surface "N statements could not be grounded in retrieved
 * evidence and were removed".
 *
 * Deliberately NOT here: NLI-style "does the cited chunk actually support
 * the claim" scoring — deferred to v2.2 confidence work per the WS-4 design
 * note. Marker integrity is mechanical and catches the worst failure mode
 * (fabricated citations).
 */
@Injectable()
export class ComposerService {
  private readonly logger = new Logger(ComposerService.name);

  /** `[claim text](cite:<id>)` — group 1 = claim text, group 2 = citation id. */
  private static readonly MARKER_SOURCE = '\\[([^\\]]*)\\]\\(cite:([^)\\s]+)\\)';

  /** Heuristic: sentences longer than this many words must carry a marker. */
  private static readonly UNMARKED_WORD_THRESHOLD = 8;

  // ---------------------------------------------------------------------------
  // verification
  // ---------------------------------------------------------------------------

  /**
   * Verifies a draft against the citations collected from this plan's step
   * outputs:
   *   - every `(cite:<id>)` marker must reference a provided citation id;
   *   - declarative sentences with no marker at all are flagged
   *     (conservatively: > 8 words, terminal '.'/'!', not a heading, not a
   *     question).
   */
  verifyDraft(draft: string, citations: Citation[]): DraftVerification {
    const knownIds = new Set(citations.map((c) => c.id));

    const unresolvedMarkers: UnresolvedMarker[] = [];
    for (const match of draft.matchAll(this.markerRegex())) {
      const [, claimText, markerId] = match;
      if (!knownIds.has(markerId)) {
        unresolvedMarkers.push({ markerId, claimText });
      }
    }

    const unmarkedSentences: string[] = [];
    for (const line of draft.split(/\r?\n/)) {
      if (this.isSkippableLine(line)) continue;
      for (const sentence of this.splitSentences(line)) {
        if (this.isUnmarkedClaim(sentence)) {
          unmarkedSentences.push(sentence);
        }
      }
    }

    return {
      valid: unresolvedMarkers.length === 0 && unmarkedSentences.length === 0,
      unresolvedMarkers,
      unmarkedSentences,
    };
  }

  // ---------------------------------------------------------------------------
  // compose loop
  // ---------------------------------------------------------------------------

  /**
   * Runs the draft -> verify -> re-ask loop. LLM-agnostic: `draftFn` is
   * injected by the planner runtime and receives structured feedback on
   * re-asks. After `maxRetries` re-asks the offending sentences are stripped
   * from the final text and returned in `removedClaims`.
   */
  async compose(
    draftFn: DraftFn,
    citations: Citation[],
    maxRetries = 2,
  ): Promise<ComposerResult> {
    let retries = 0;
    let draft = await draftFn();
    let verification = this.verifyDraft(draft, citations);

    while (!verification.valid && retries < maxRetries) {
      retries++;
      const feedback = this.buildFeedback(verification, citations);
      this.logger.debug(
        `Composer re-ask ${retries}/${maxRetries}: ` +
          `${verification.unresolvedMarkers.length} unresolved marker(s), ` +
          `${verification.unmarkedSentences.length} unmarked sentence(s)`,
      );
      draft = await draftFn(feedback);
      verification = this.verifyDraft(draft, citations);
    }

    if (verification.valid) {
      return {
        text: draft,
        citationMap: this.buildCitationMap(draft, citations),
        removedClaims: [],
        retries,
      };
    }

    const { text, removedClaims } = this.stripOffendingSentences(
      draft,
      verification,
    );
    this.logger.warn(
      `Composer removed ${removedClaims.length} ungrounded claim(s) after ` +
        `${retries} re-ask(s)`,
    );
    return {
      text,
      citationMap: this.buildCitationMap(text, citations),
      removedClaims,
      retries,
    };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private markerRegex(): RegExp {
    // A fresh instance per use: a shared global regex carries lastIndex state.
    return new RegExp(ComposerService.MARKER_SOURCE, 'g');
  }

  /** Headings and blank lines are never treated as factual claims. */
  private isSkippableLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    if (/^#{1,6}\s/.test(trimmed)) return true; // markdown heading
    return false;
  }

  private splitSentences(line: string): string[] {
    return line
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Conservative unmarked-claim heuristic: flag only sentences that
   *   - carry no citation marker,
   *   - are declarative (end in '.' or '!'; questions and unpunctuated
   *     fragments/headings are skipped),
   *   - exceed the word threshold (short connective sentences pass).
   */
  private isUnmarkedClaim(sentence: string): boolean {
    if (this.markerRegex().test(sentence)) return false;
    if (!/[.!]$/.test(sentence)) return false;
    const words = sentence.split(/\s+/).filter((w) => w.length > 0);
    return words.length > ComposerService.UNMARKED_WORD_THRESHOLD;
  }

  /**
   * Structured, LLM-readable feedback for the bounded re-ask: names each
   * fabricated citation id with its claim, each uncited sentence, and the
   * set of citation ids that are actually available.
   */
  private buildFeedback(
    verification: DraftVerification,
    citations: Citation[],
  ): string {
    const lines: string[] = [
      'Your draft failed citation verification. Fix the problems below and ' +
        'rewrite the full answer. Only cite ids from the valid citation id ' +
        'list; if no citation supports a claim, remove the claim.',
    ];
    if (verification.unresolvedMarkers.length > 0) {
      lines.push('', 'Claims citing ids that were NOT retrieved by this plan:');
      for (const m of verification.unresolvedMarkers) {
        lines.push(
          `- claim "${m.claimText}" cites "${m.markerId}", which does not ` +
            `exist in this plan's retrieved evidence`,
        );
      }
    }
    if (verification.unmarkedSentences.length > 0) {
      lines.push('', 'Sentences with no citation marker:');
      for (const s of verification.unmarkedSentences) {
        lines.push(
          `- "${s}" — every factual sentence must carry at least one ` +
            `[claim text](cite:<id>) marker`,
        );
      }
    }
    lines.push(
      '',
      `Valid citation ids: ${citations.map((c) => c.id).join(', ') || '(none)'}`,
    );
    return lines.join('\n');
  }

  /**
   * Removes the sentences that still fail verification after retries are
   * exhausted: sentences carrying a fabricated citation id and uncited
   * declarative sentences. Returns the cleaned text plus the removed claims
   * (marker syntax flattened to plain claim text) in document order.
   */
  private stripOffendingSentences(
    draft: string,
    verification: DraftVerification,
  ): { text: string; removedClaims: string[] } {
    const unresolvedIds = new Set(
      verification.unresolvedMarkers.map((m) => m.markerId),
    );
    const unmarkedSet = new Set(verification.unmarkedSentences);
    const removedClaims: string[] = [];

    const keptLines: string[] = [];
    for (const line of draft.split(/\r?\n/)) {
      if (this.isSkippableLine(line)) {
        keptLines.push(line);
        continue;
      }
      const kept: string[] = [];
      for (const sentence of this.splitSentences(line)) {
        if (unmarkedSet.has(sentence)) {
          removedClaims.push(sentence);
          continue;
        }
        const markerIds = [...sentence.matchAll(this.markerRegex())].map(
          (m) => m[2],
        );
        if (markerIds.some((id) => unresolvedIds.has(id))) {
          removedClaims.push(this.flattenMarkers(sentence));
          continue;
        }
        kept.push(sentence);
      }
      if (kept.length > 0) {
        keptLines.push(kept.join(' '));
      }
    }

    return { text: keptLines.join('\n'), removedClaims };
  }

  /** `[claim](cite:x)` -> `claim`, for human-readable removedClaims. */
  private flattenMarkers(text: string): string {
    return text.replace(this.markerRegex(), '$1');
  }

  /**
   * Marker id -> Citation map for every resolvable marker present in the
   * final text. For the marker-integrity path the marker id is the citation
   * id itself (see composer.types.ts).
   */
  private buildCitationMap(
    text: string,
    citations: Citation[],
  ): Record<string, Citation> {
    const byId = new Map(citations.map((c) => [c.id, c]));
    const map: Record<string, Citation> = {};
    for (const match of text.matchAll(this.markerRegex())) {
      const markerId = match[2];
      const citation = byId.get(markerId);
      if (citation) {
        map[markerId] = citation;
      }
    }
    return map;
  }
}
