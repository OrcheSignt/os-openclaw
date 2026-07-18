import { Injectable, Logger } from '@nestjs/common';
import type { Citation } from './composer.types.js';

/**
 * Per-pod, in-memory execution state for a plan: the citations registered by
 * record_step_result (the only valid targets for compose_answer markers),
 * the recorded step results, and the compose re-ask counter.
 *
 * This is deliberately NOT persisted: a plan executes within one agent
 * session against one pod, so the registry is a session-scoped scratchpad.
 * The durable record is the agent_plans document plus the audit trail —
 * losing a registry entry (pod restart, TTL) only forces the agent to
 * re-execute steps, never to lose audited history.
 */
export interface RecordedStepResult {
  stepId: string;
  summary: string;
  citationIds: string[];
  auditId?: string;
  recordedAt: number;
}

export interface PlanExecutionState {
  planId: string;
  /** Citations registered so far, deduplicated by Citation.id. */
  citations: Citation[];
  stepResults: RecordedStepResult[];
  /** Number of failed compose_answer verifications so far (bounded re-ask). */
  composeAttempts: number;
  createdAt: number;
  expiresAt: number;
}

/** A plan executes within one agent session; ~1h is a generous backstop. */
export const PLAN_EXECUTION_TTL_MS = 60 * 60 * 1000;
export const PLAN_EXECUTION_MAX_ENTRIES = 100;

@Injectable()
export class PlanExecutionRegistry {
  private readonly logger = new Logger(PlanExecutionRegistry.name);

  /** planId -> state; Map iteration order doubles as LRU recency order. */
  private readonly entries = new Map<string, PlanExecutionState>();

  /** Number of live (non-expired-at-last-touch) entries. For diagnostics/tests. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Returns the live entry for `planId`, or null if absent/expired.
   * Touching an entry refreshes its LRU recency (not its TTL).
   */
  get(planId: string): PlanExecutionState | null {
    const entry = this.entries.get(planId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(planId);
      this.logger.debug(`Plan execution state for "${planId}" expired (TTL)`);
      return null;
    }
    // Refresh recency: re-insert so Map order reflects least-recently-used.
    this.entries.delete(planId);
    this.entries.set(planId, entry);
    return entry;
  }

  getOrCreate(planId: string): PlanExecutionState {
    const existing = this.get(planId);
    if (existing) return existing;
    const now = Date.now();
    const entry: PlanExecutionState = {
      planId,
      citations: [],
      stepResults: [],
      composeAttempts: 0,
      createdAt: now,
      expiresAt: now + PLAN_EXECUTION_TTL_MS,
    };
    this.entries.set(planId, entry);
    this.evictIfOverBound();
    return entry;
  }

  /**
   * Registers a step result and merges its citations (dedup by Citation.id —
   * the same item cited by two steps is one citation target). Sliding TTL:
   * recording activity keeps the session alive.
   */
  recordStep(
    planId: string,
    stepId: string,
    summary: string,
    citations: Citation[],
    auditId?: string,
  ): PlanExecutionState {
    const entry = this.getOrCreate(planId);
    const known = new Set(entry.citations.map((c) => c.id));
    for (const citation of citations) {
      if (!known.has(citation.id)) {
        known.add(citation.id);
        entry.citations.push(citation);
      }
    }
    entry.stepResults.push({
      stepId,
      summary,
      citationIds: citations.map((c) => c.id),
      auditId,
      recordedAt: Date.now(),
    });
    entry.expiresAt = Date.now() + PLAN_EXECUTION_TTL_MS;
    return entry;
  }

  /** Increments and returns the compose re-ask counter for the plan. */
  incrementComposeAttempts(planId: string): number {
    const entry = this.getOrCreate(planId);
    entry.composeAttempts++;
    return entry.composeAttempts;
  }

  /** Drops the entry (plan finished or aborted). */
  delete(planId: string): void {
    this.entries.delete(planId);
  }

  private evictIfOverBound(): void {
    while (this.entries.size > PLAN_EXECUTION_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.logger.debug(`Plan execution registry LRU evicted "${oldest}"`);
    }
  }
}
