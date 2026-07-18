import type { GatewayClientService } from '../../gateway-client/gateway-client.service.js';
import type { AgentIdentity } from '../../security/agent-identity.service.js';
import type { McpToolHttpRequest } from '../../security/agent-context.js';

/**
 * Audit v2 entry shape (plan §8.3) shared by the `log_audit` tool
 * (management.tools.ts) and the planner tool family (planner.tools.ts).
 * Factored so the audit payload — actor block, org pinning, provenance
 * linkage — is built in exactly one place.
 */
export interface AgentAuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category?: string;
  compliance?: {
    gdprRelevant?: boolean;
    ccpaRelevant?: boolean;
    retentionRequired?: boolean;
  };
  details?: string;
  planId?: string;
  stepId?: string;
  provenance?: {
    itemIds?: string[];
    searchIds?: string[];
    auditIds?: string[];
  };
  resultHash?: string;
}

/**
 * Posts an append-only audit record via the gateway, stamped with the
 * organizationId governing the REQUEST (the deploy pin in static mode, the
 * verified authContext org in dynamic mode — see requireOrganizationId)
 * and the audit-v2 actor block.
 *
 * Actor block per plan §8.3: agent id + token jti + request id, extended
 * with the user behind the call. When a verified authContext accompanied
 * the request (req.authContext, attached by requireOrganizationId), the
 * actor carries that user's id and the token's jti; otherwise both are
 * null (static single-tenant deploys without user context). The agent
 * transport bearer is still a static token, so the agent-token jti field
 * remains null as before.
 */
export async function postAgentAudit(
  gateway: GatewayClientService,
  agent: AgentIdentity,
  req: McpToolHttpRequest | undefined,
  organizationId: string,
  entry: AgentAuditEntry,
): Promise<void> {
  const requestIdHeader = req?.headers?.['x-request-id'];
  const requestId = Array.isArray(requestIdHeader)
    ? requestIdHeader[0]
    : requestIdHeader;
  const authContext = req?.authContext;

  await gateway.post<unknown>('project', '/audit-logs', {
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    severity: entry.severity ?? 'LOW',
    category: entry.category,
    compliance: entry.compliance,
    details: entry.details,
    organizationId,
    source: 'openclaw-agent',
    timestamp: new Date().toISOString(),
    // --- audit v2 (plan §8.3) ---
    actor: {
      agentId: agent.id,
      userId: authContext?.userId ?? null,
      tokenJti: null,
      authContextJti: authContext?.jti ?? null,
      requestId: requestId ?? null,
    },
    planId: entry.planId,
    stepId: entry.stepId,
    provenance: entry.provenance,
    resultHash: entry.resultHash,
  });
}
