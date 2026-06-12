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
 * agent's pinned organizationId and the audit-v2 actor block.
 *
 * Actor block per plan §8.3: agent id + token jti + request id.
 * NOTE: AgentIdentity carries no `jti` today — agents authenticate with
 * static bearer tokens (AgentIdentityService), not JWTs, so there is no
 * jti to record. The field is emitted (null) so the audit schema is
 * stable if/when agent tokens become JWTs. Request id is taken from the
 * inbound x-request-id header when the transport provides one.
 */
export async function postAgentAudit(
  gateway: GatewayClientService,
  agent: AgentIdentity,
  req: McpToolHttpRequest | undefined,
  entry: AgentAuditEntry,
): Promise<void> {
  const requestIdHeader = req?.headers?.['x-request-id'];
  const requestId = Array.isArray(requestIdHeader)
    ? requestIdHeader[0]
    : requestIdHeader;

  await gateway.post<unknown>('project', '/audit-logs', {
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    severity: entry.severity ?? 'LOW',
    category: entry.category,
    compliance: entry.compliance,
    details: entry.details,
    organizationId: agent.organizationId,
    source: 'openclaw-agent',
    timestamp: new Date().toISOString(),
    // --- audit v2 (plan §8.3) ---
    actor: {
      agentId: agent.id,
      tokenJti: null,
      requestId: requestId ?? null,
    },
    planId: entry.planId,
    stepId: entry.stepId,
    provenance: entry.provenance,
    resultHash: entry.resultHash,
  });
}
