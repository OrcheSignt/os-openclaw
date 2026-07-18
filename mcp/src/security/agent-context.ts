import { ForbiddenException } from '@nestjs/common';
import type { AgentIdentity } from './agent-identity.service.js';
import type { CaseContext } from './case-context.service.js';
import {
  verifyAuthContext,
  type VerifiedAuthContext,
} from './auth-context.service.js';

/**
 * Shape of the third argument that @rekog/mcp-nest passes to @Tool handlers.
 * It is the raw Express request augmented by McpAuthGuard (openClawAgent),
 * by requireOrganizationId (authContext, when a verified user-context token
 * accompanied the call), and, for case-scoped tool calls, by
 * CaseContextService.requireCaseContext (caseContext).
 */
export interface McpToolHttpRequest {
  openClawAgent?: AgentIdentity;
  caseContext?: CaseContext;
  /** Verified user context attached by requireOrganizationId. */
  authContext?: VerifiedAuthContext;
  /** Express request headers (present on the HTTP transport). */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Extracts the agent identity that the guard attached to the request.
 *
 * Throws when no identity is present, which would only happen if the guard
 * was bypassed (e.g. misconfigured deploy). Treat this as fail-closed.
 */
export function requireAgent(req: McpToolHttpRequest | undefined): AgentIdentity {
  const agent = req?.openClawAgent;
  if (!agent) {
    throw new ForbiddenException(
      'No agent identity on request. McpAuthGuard must run before tool handlers.',
    );
  }
  return agent;
}

/**
 * Defense-in-depth allowlist check inside the tool handler. The guard also
 * enforces this for tools/call but we re-check here so the rule cannot be
 * bypassed if the guard wiring is ever changed.
 */
export function assertAgentMayCall(
  agent: AgentIdentity,
  toolName: string,
): void {
  if (agent.allow === null) return;
  if (!agent.allow.has(toolName)) {
    throw new ForbiddenException(
      `Agent "${agent.id}" is not permitted to call tool "${toolName}"`,
    );
  }
}

/**
 * Reconciles the LLM-supplied organizationId (if any) with the
 * organizationId pinned to the agent identity. The pinned value always
 * wins; an LLM-supplied value that disagrees is a hard error -- silently
 * overriding would hide prompt-injection attempts.
 *
 * @deprecated Tool handlers must resolve the org via
 * requireOrganizationId(req, agent, authContext) instead, which supports
 * both STATIC (deploy-pinned) and DYNAMIC (per-request authContext) org
 * binding. This function only understands the static pin and is kept for
 * the static path's internals; it fails closed for dynamic-mode agents.
 */
export function resolveOrganizationId(
  agent: AgentIdentity,
  llmSupplied?: string | null,
): string {
  if (agent.organizationId === null) {
    throw new ForbiddenException(
      `Agent "${agent.id}" has no statically pinned organizationId ` +
        `(dynamic org binding). The org must be resolved from a verified ` +
        `authContext token via requireOrganizationId().`,
    );
  }
  if (llmSupplied && llmSupplied !== agent.organizationId) {
    throw new ForbiddenException(
      `organizationId "${llmSupplied}" supplied by caller does not match ` +
        `the organizationId pinned to agent "${agent.id}".`,
    );
  }
  return agent.organizationId;
}

/**
 * Resolves the organizationId governing THIS tool call — the single entry
 * point every tool handler must use. Implements the two org binding modes
 * (see AgentIdentity in agent-identity.service.ts):
 *
 * STATIC mode (agent.organizationId pinned at deploy):
 *   - the pinned org is authoritative;
 *   - if the call ALSO carries an authContext token, it is verified and
 *     its org must equal the pin — a mismatch is a hard ForbiddenException
 *     (an org-hopping/injection signal), never silently corrected.
 *
 * DYNAMIC mode (agent.organizationId === null):
 *   - every tool call MUST carry a valid authContext token signed by
 *     os-investigation (HS256, shared JWT_SECRET, scope 'openclaw-agent');
 *   - the request org is the verified token org — the active org of the
 *     user who started the chat/procedure;
 *   - a missing, expired, or invalid token fails closed.
 *
 * On success the verified context (when present) is attached to
 * req.authContext so downstream code (audit actor block, case-context
 * checks) can read it without re-verifying.
 */
export function requireOrganizationId(
  req: McpToolHttpRequest | undefined,
  agent: AgentIdentity,
  authContext?: string,
): string {
  // STATIC mode — deploy-pinned org.
  if (agent.organizationId !== null) {
    if (authContext) {
      const verified = verifyAuthContext(authContext);
      if (verified.organizationId !== agent.organizationId) {
        throw new ForbiddenException(
          `authContext org "${verified.organizationId}" does not match the ` +
            `organizationId pinned to agent "${agent.id}". Refusing the ` +
            `call — this is treated as an injection signal.`,
        );
      }
      if (req) req.authContext = verified;
    }
    return resolveOrganizationId(agent);
  }

  // DYNAMIC mode — org comes from the verified user-context token only.
  if (!authContext) {
    throw new ForbiddenException(
      `Agent "${agent.id}" is deployed with dynamic org binding: every ` +
        `tool call must include the "authContext" parameter — the signed ` +
        `user context token from your session context, passed verbatim.`,
    );
  }
  const verified = verifyAuthContext(authContext);
  if (req) req.authContext = verified;
  return verified.organizationId;
}
