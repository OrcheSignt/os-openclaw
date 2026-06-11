import { ForbiddenException } from '@nestjs/common';
import type { AgentIdentity } from './agent-identity.service.js';
import type { CaseContext } from './case-context.service.js';

/**
 * Shape of the third argument that @rekog/mcp-nest passes to @Tool handlers.
 * It is the raw Express request augmented by McpAuthGuard (openClawAgent)
 * and, for case-scoped tool calls, by CaseContextService.requireCaseContext
 * (caseContext).
 */
export interface McpToolHttpRequest {
  openClawAgent?: AgentIdentity;
  caseContext?: CaseContext;
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
 */
export function resolveOrganizationId(
  agent: AgentIdentity,
  llmSupplied?: string | null,
): string {
  if (llmSupplied && llmSupplied !== agent.organizationId) {
    throw new ForbiddenException(
      `organizationId "${llmSupplied}" supplied by caller does not match ` +
        `the organizationId pinned to agent "${agent.id}".`,
    );
  }
  return agent.organizationId;
}
