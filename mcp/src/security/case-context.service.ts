import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { GatewayClientService } from '../gateway-client/gateway-client.service.js';
import type { AgentIdentity } from './agent-identity.service.js';
import {
  requireAgent,
  requireOrganizationId,
  type McpToolHttpRequest,
} from './agent-context.js';

// ---------------------------------------------------------------------------
// Contract types for GET /internal/case-context/:caseId (WS-1, os-investigation)
// ---------------------------------------------------------------------------

export interface DoctrineDefinition {
  term: string;
  definition: string;
}

export interface DoctrineTarget {
  kind: string;
  indicators: string[];
}

export interface DoctrineDecisionRule {
  trigger: string;
  action: string;
  rationale: string;
}

export interface CaseTypeDoctrine {
  definitions: DoctrineDefinition[];
  targets: DoctrineTarget[];
  decisionRules: DoctrineDecisionRule[];
}

export interface CaseTypeContext {
  key: string;
  name: string;
  version: number;
  doctrine: CaseTypeDoctrine;
  vocabulary?: Record<string, unknown>;
  defaultViews?: unknown[];
  defaultProfile?: unknown;
  defaultCoding?: unknown;
}

export interface LegalReference {
  name: string;
  citation: string;
  jurisdiction: string;
  description?: string;
  keySections?: string[];
  relevance?: string;
}

export interface CaseMeta {
  name: string;
  investigationNumber?: string;
  type: string;
  status?: string;
  priority?: string;
  startDate?: string;
  dueDate?: string;
  tags?: string[];
}

/**
 * The assembled case context returned by the WS-1 gateway endpoint
 * (`GET /internal/case-context/:caseId`) in a single round-trip.
 * See V2_AI_AGENT_PLATFORM.md §3.4 and V2_0_FOUNDATION_PLAN.md WS-1/WS-2.
 */
export interface CaseContext {
  caseId: string;
  organizationId: string;
  caseType: CaseTypeContext;
  legalReferences: LegalReference[];
  caseMeta: CaseMeta;
  fieldProfile?: unknown;
  searchViews?: unknown[];
}

// ---------------------------------------------------------------------------
// LRU cache internals
// ---------------------------------------------------------------------------

interface CacheEntry {
  context: CaseContext;
  /**
   * caseType.version captured at fetch time. The cache is keyed by caseId
   * (the version is only knowable after a fetch), so the version is stored
   * here for invalidation: a caller that knows a newer doctrine version can
   * call invalidateIfStale(), and diagnostics can compare it.
   */
  version: number;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // ~5 min backstop for caseMeta/doctrine edits
const CACHE_MAX_ENTRIES = 200;

/**
 * WS-2 Case Context Provider — sibling to agent-context.
 *
 * Fetches the one-round-trip case context document from os-investigation via
 * the gateway and pins it to the calling agent's organization, fail-closed.
 *
 * INJECTION PATH DECISION (WS-2 "guard vs helper"):
 * We implement the `requireCaseContext(req, caseId)` helper rather than
 * resolving case context inside McpAuthGuard, for four reasons:
 *   1. The guard only sees the *raw, pre-validation* JSON-RPC body on the
 *      streamable-HTTP transport (`body.params.arguments`), and only because
 *      the controller happens to declare @Body(). That is best-effort (see
 *      the allowlist note in mcp-auth.guard.ts) — STDIO/raw transports and
 *      batched requests bypass it, so it is not a *reliable* place to read
 *      parsed tool arguments.
 *   2. Resolution requires an async gateway round-trip; doing it in the
 *      guard would tax every tools/call — including the many tools that
 *      take no caseId — for the benefit of a few.
 *   3. A guard failure surfaces as a transport-level 401/403, not as a tool
 *      result the planner LLM can read and correct; the helper throws inside
 *      the handler where @rekog/mcp-nest converts it to a tool error.
 *   4. It mirrors the established `requireAgent(req)` pattern that every
 *      tool handler already follows, with the same fail-closed posture.
 * The helper still attaches the resolved context to `req.caseContext` so
 * downstream code in the same request sees the guard-style augmentation.
 */
@Injectable()
export class CaseContextService {
  private readonly logger = new Logger(CaseContextService.name);

  /** caseId -> entry; Map iteration order doubles as LRU recency order. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly gateway: GatewayClientService) {}

  /**
   * Resolves the case context for `caseId` and verifies it belongs to the
   * REQUEST organization — the org governing this tool call (the deploy
   * pin in static mode, or the verified authContext org in dynamic mode).
   *
   * SECURITY: `caseId` is LLM-supplied. Mirroring requireOrganizationId(),
   * an organization mismatch is treated as a prompt-injection signal and is
   * a hard ForbiddenException — never silently corrected. The org check runs
   * on every call, including cache hits, so a cached context can never leak
   * across organizations.
   */
  async getCaseContext(
    caseId: string,
    agent: AgentIdentity,
    requestOrganizationId: string,
  ): Promise<CaseContext> {
    if (!caseId || typeof caseId !== 'string') {
      throw new ForbiddenException(
        'A non-empty caseId is required to resolve case context.',
      );
    }

    const cached = this.cacheGet(caseId);
    if (cached) {
      this.assertOrganization(cached.context, agent, requestOrganizationId);
      return cached.context;
    }

    const context = await this.fetchCaseContext(caseId);
    this.cacheSet(caseId, context);
    this.assertOrganization(context, agent, requestOrganizationId);
    return context;
  }

  /**
   * Tool-handler entry point (the requireAgent()-style helper).
   * Fail-closed: throws if the agent identity is missing, the org for this
   * call cannot be established (requireOrganizationId — in dynamic mode
   * this is where a missing/invalid authContext is rejected), the caseId is
   * unusable, the backend cannot assemble the context, or the case belongs
   * to a different organization. Attaches the result to req.caseContext.
   */
  async requireCaseContext(
    req: McpToolHttpRequest | undefined,
    caseId: string,
    authContext?: string,
  ): Promise<CaseContext> {
    const agent = requireAgent(req);
    const requestOrganizationId = requireOrganizationId(
      req,
      agent,
      authContext,
    );
    const context = await this.getCaseContext(
      caseId,
      agent,
      requestOrganizationId,
    );
    if (req) {
      req.caseContext = context;
    }
    return context;
  }

  /**
   * Drops the cached entry when the caller learns of a newer doctrine
   * version (e.g. from an audit reference). Returns true if invalidated.
   */
  invalidateIfStale(caseId: string, knownVersion: number): boolean {
    const entry = this.cache.get(caseId);
    if (entry && entry.version < knownVersion) {
      this.cache.delete(caseId);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async fetchCaseContext(caseId: string): Promise<CaseContext> {
    const raw = await this.gateway.getCaseContext<CaseContext>(caseId);

    // Fail-closed shape check: without organizationId we cannot enforce
    // tenancy, and without caseType.version we cannot reason about staleness.
    if (!raw || typeof raw.organizationId !== 'string' || !raw.organizationId) {
      throw new ForbiddenException(
        `Case context for case "${caseId}" did not include an organizationId; ` +
          `refusing to use an unscoped context.`,
      );
    }
    if (typeof raw.caseType?.version !== 'number') {
      throw new ForbiddenException(
        `Case context for case "${caseId}" did not include caseType.version; ` +
          `refusing to use a malformed context.`,
      );
    }
    return raw;
  }

  private assertOrganization(
    context: CaseContext,
    agent: AgentIdentity,
    requestOrganizationId: string,
  ): void {
    if (context.organizationId !== requestOrganizationId) {
      throw new ForbiddenException(
        `Case "${context.caseId}" belongs to organization ` +
          `"${context.organizationId}", which does not match the ` +
          `organizationId "${requestOrganizationId}" governing this call ` +
          `by agent "${agent.id}". Refusing to provide case context.`,
      );
    }
  }

  private cacheGet(caseId: string): CacheEntry | null {
    const entry = this.cache.get(caseId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(caseId);
      return null;
    }
    // Refresh recency: re-insert so Map order reflects least-recently-used.
    this.cache.delete(caseId);
    this.cache.set(caseId, entry);
    return entry;
  }

  private cacheSet(caseId: string, context: CaseContext): void {
    if (this.cache.has(caseId)) this.cache.delete(caseId);
    this.cache.set(caseId, {
      context,
      version: context.caseType.version,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.logger.debug(`Case-context LRU evicted "${oldest}"`);
    }
  }
}
