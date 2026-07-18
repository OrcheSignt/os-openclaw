/**
 * WS-4 Composer types — citation-marker integrity verification
 * (V2_AI_AGENT_PLATFORM.md §3.5, cheap path: marker integrity, not NLI
 * claim-support scoring — that is v2.2 confidence work).
 */

/**
 * A structured citation carried by a capability-call output collected from
 * the plan's dispatches. `id` is the value the LLM must reference in inline
 * markers: `[claim text](cite:<id>)`.
 */
export interface Citation {
  id: string;
  itemId: string;
  chunkId?: string;
  searchId?: string;
  auditId?: string;
}

/**
 * Final composer output. `citationMap` is keyed by the marker id as it
 * appears in the text — for the marker-integrity path the marker id IS the
 * citation id referenced by `(cite:<id>)`, so keys map 1:1 onto Citation.id.
 */
export interface ComposerResult {
  text: string;
  citationMap: Record<string, Citation>;
  removedClaims: string[];
  retries: number;
}

/** A marker whose cited id does not exist among this plan's citations. */
export interface UnresolvedMarker {
  markerId: string;
  claimText: string;
}

export interface DraftVerification {
  valid: boolean;
  unresolvedMarkers: UnresolvedMarker[];
  unmarkedSentences: string[];
}

/**
 * LLM-agnostic draft producer injected into compose(). Called with no
 * feedback on the first attempt and with structured verification feedback
 * on re-asks.
 */
export type DraftFn = (feedback?: string) => Promise<string>;
