import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';
import { CaseContextService } from '../../security/case-context.service.js';
import {
  assertAgentMayCall,
  requireAgent,
  requireOrganizationId,
  type McpToolHttpRequest,
} from '../../security/agent-context.js';
import type { AgentIdentity } from '../../security/agent-identity.service.js';
import { authContextParam } from '../shared/auth-context-param.js';
import { validatePlan, type PlanStatus } from '../../planner/plan-dsl.js';
import { ComposerService } from '../../planner/composer.service.js';
import { PlanExecutionRegistry } from '../../planner/plan-execution-registry.js';
import type { Citation } from '../../planner/composer.types.js';
import { postAgentAudit } from '../shared/agent-audit.js';

/**
 * v2.0 planner RUNTIME as an MCP tool family.
 *
 * The OpenClaw agent runtime is an external package — we cannot wrap the LLM
 * loop in code. The planner lifecycle (V2_AI_AGENT_PLATFORM.md §3.2) is
 * therefore enforced as tools the agent is obligated (via SKILL.md) to call:
 * the LLM drives; these tools gate.
 *
 *   submit_plan        -> validate (plan DSL) + persist (agent_plans) + audit
 *   get_plan           -> poll status (await operator approval)
 *   record_step_result -> register step citations, approved -> executing
 *   compose_answer     -> Composer citation gate, executing -> done
 *   abort_plan         -> any live status -> aborted
 *
 * APPROVAL IS NOT THE AGENT'S TO GIVE. There is deliberately NO tool in this
 * family (or anywhere on this MCP server) that transitions a plan from
 * `draft` to `approved`. Approval belongs to the operator (backend/UI), or —
 * in demo/dev deployments only — to the server itself when
 * OPENCLAW_PLAN_AUTOAPPROVE === 'true' (`by: 'system:auto-approve'`).
 * An agent that wants its plan approved can only wait and poll get_plan.
 */

/** Backend status-transition contract (os-investigation agent-plans):
 *  draft -> approved -> executing -> done | aborted, plus
 *  draft/approved -> aborted. Illegal transition = HTTP 409. */
const LEGAL_TRANSITIONS_HINT =
  'Legal transitions: draft -> approved -> executing -> done | aborted ' +
  '(abort is also legal from draft and approved).';

/** Failed compose_answer verifications allowed before stripping (mirrors
 *  ComposerService.compose's default maxRetries). */
const COMPOSE_MAX_ATTEMPTS = 2;

/** Shape of the persisted agent_plans document we rely on. */
interface PersistedAgentPlan {
  planId: string;
  caseId: string;
  agentId: string;
  intent: string;
  steps: Array<{ stepId: string; tool: string }>;
  status: PlanStatus;
  organizationId?: string;
}

const citationParamSchema = z.object({
  itemId: z.string().min(1).describe('Evidence item id the step result cites'),
  chunkId: z
    .string()
    .optional()
    .describe('Chunk id within the item, when the citation is chunk-level'),
  searchId: z
    .string()
    .optional()
    .describe('Search id that surfaced this item, when applicable'),
});

@Injectable()
export class PlannerTools {
  private readonly logger = new Logger(PlannerTools.name);

  constructor(
    private readonly gateway: GatewayClientService,
    private readonly caseContext: CaseContextService,
    private readonly composer: ComposerService,
    private readonly registry: PlanExecutionRegistry,
  ) {}

  // ===========================================================================
  // submit_plan
  // ===========================================================================

  @Tool({
    name: 'submit_plan',
    description:
      'Submit a plan (intent + steps) for the given case. The plan is ' +
      'validated against the plan DSL and persisted as a draft awaiting ' +
      'operator approval. On validation failure the errors are returned — ' +
      'fix exactly what is reported and call submit_plan again. You cannot ' +
      'approve your own plan; poll get_plan until it is approved.',
    parameters: z.object({
      caseId: z.string().min(1).describe('The case this plan operates on'),
      intent: z
        .string()
        .min(1)
        .describe('The operator request, restated precisely'),
      // Deliberately loose: real validation happens in validatePlan so the
      // agent gets LLM-readable errors as a tool RESULT it can act on,
      // instead of an opaque transport-level schema rejection.
      steps: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'Plan steps: [{ stepId, tool, params, successCriterion, dependsOn[] }]',
        ),
      authContext: authContextParam,
    }),
  })
  async submitPlan(
    params: {
      caseId: string;
      intent: string;
      steps: Array<Record<string, unknown>>;
      authContext?: string;
    },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'submit_plan');
    const organizationId = requireOrganizationId(
      req,
      agent,
      params.authContext,
    );

    // Fail-closed org validation: resolving the case context verifies the
    // LLM-supplied caseId belongs to the REQUEST organization (static pin
    // or verified authContext org — ForbiddenException on mismatch). The
    // context fetch IS the org check — nothing from it is attached to the
    // tool response.
    await this.caseContext.requireCaseContext(
      req,
      params.caseId,
      params.authContext,
    );

    // The runtime owns planId / agentId / status — never the LLM.
    const planId = randomUUID();
    const validated = validatePlan({
      planId,
      caseId: params.caseId,
      agentId: agent.id,
      intent: params.intent,
      steps: params.steps,
      status: 'draft' satisfies PlanStatus,
    });

    if (!validated.ok) {
      // The re-ask loop: the agent reads these errors, fixes the plan, and
      // calls submit_plan again. No server-side retry cap at this stage —
      // each resubmission is an independent tool call.
      return this.text(
        'Plan validation failed — the plan was NOT persisted. Fix the ' +
          'problems below and call submit_plan again with the corrected plan:\n' +
          validated.errors.map((e) => `- ${e}`).join('\n'),
      );
    }

    await this.gateway.createAgentPlan(
      validated.plan as unknown as Record<string, unknown>,
      organizationId,
      agent.id,
    );
    this.registry.getOrCreate(planId);

    await postAgentAudit(this.gateway, agent, req, organizationId, {
      action: 'plan_submitted',
      resourceType: 'agent_plan',
      resourceId: planId,
      category: agent.id,
      details: `intent: ${params.intent}`.slice(0, 2000),
      planId,
    });

    // Demo/dev convenience ONLY: the SERVER (not the agent) approves.
    if (process.env.OPENCLAW_PLAN_AUTOAPPROVE === 'true') {
      await this.transition(planId, 'approved', 'system:auto-approve');
      await postAgentAudit(this.gateway, agent, req, organizationId, {
        action: 'plan_auto_approved',
        resourceType: 'agent_plan',
        resourceId: planId,
        category: agent.id,
        details: 'OPENCLAW_PLAN_AUTOAPPROVE=true (demo/dev mode)',
        planId,
      });
      return this.text(
        `Plan ${planId} submitted and auto-approved by the server ` +
          `(OPENCLAW_PLAN_AUTOAPPROVE demo/dev mode). Status: approved. ` +
          `Execute the steps now; after each step call record_step_result ` +
          `with the citations from the tool output.`,
      );
    }

    return this.text(
      `Plan ${planId} submitted. Status: draft — operator approval is ` +
        `pending. You cannot approve your own plan. Poll ` +
        `get_plan({ planId: "${planId}" }) and begin executing steps only ` +
        `once status is "approved".`,
    );
  }

  // ===========================================================================
  // get_plan
  // ===========================================================================

  @Tool({
    name: 'get_plan',
    description:
      'Fetch a plan and its current status. Use this to poll for operator ' +
      'approval after submit_plan (execute steps only once status is "approved").',
    parameters: z.object({
      planId: z.string().min(1).describe('The plan id returned by submit_plan'),
      authContext: authContextParam,
    }),
  })
  async getPlan(
    params: { planId: string; authContext?: string },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'get_plan');
    const organizationId = requireOrganizationId(
      req,
      agent,
      params.authContext,
    );

    const plan = await this.fetchPlanForAgent(
      params.planId,
      agent,
      organizationId,
    );
    return this.text(
      JSON.stringify(
        {
          planId: plan.planId,
          status: plan.status,
          caseId: plan.caseId,
          agentId: plan.agentId,
          intent: plan.intent,
          steps: plan.steps,
        },
        null,
        2,
      ),
    );
  }

  // ===========================================================================
  // record_step_result
  // ===========================================================================

  @Tool({
    name: 'record_step_result',
    description:
      'Record the outcome of one executed plan step: a summary plus the ' +
      'citations (itemId, optional chunkId/searchId) taken from the tool ' +
      'output. Must be called after every step — the registered citation ids ' +
      'are the only valid targets for compose_answer markers. The first ' +
      'recorded step moves an approved plan to executing.',
    parameters: z.object({
      planId: z.string().min(1).describe('The plan id'),
      stepId: z.string().min(1).describe('The plan stepId that was executed'),
      summary: z
        .string()
        .min(1)
        .max(4000)
        .describe('What the step did and found, judged against its successCriterion'),
      citations: z
        .array(citationParamSchema)
        .default([])
        .describe(
          'Citations from the step output. May be empty for steps that ' +
            'produce no evidence (e.g. tagging).',
        ),
      auditId: z
        .string()
        .optional()
        .describe('Audit id returned by the dispatched tool, if any'),
      authContext: authContextParam,
    }),
  })
  async recordStepResult(
    params: {
      planId: string;
      stepId: string;
      summary: string;
      citations: Array<{ itemId: string; chunkId?: string; searchId?: string }>;
      auditId?: string;
      authContext?: string;
    },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'record_step_result');
    const organizationId = requireOrganizationId(
      req,
      agent,
      params.authContext,
    );

    const plan = await this.fetchPlanForAgent(
      params.planId,
      agent,
      organizationId,
    );

    if (plan.status === 'draft') {
      return this.text(
        `Plan ${params.planId} is still in status "draft" — operator ` +
          `approval is pending and no steps may execute yet. Poll ` +
          `get_plan({ planId: "${params.planId}" }) and wait for status ` +
          `"approved" before executing and recording steps.`,
      );
    }
    if (plan.status === 'done' || plan.status === 'aborted') {
      return this.text(
        `Plan ${params.planId} is "${plan.status}" — no further step ` +
          `results can be recorded. Submit a new plan if more work is needed.`,
      );
    }

    const step = (plan.steps ?? []).find((s) => s.stepId === params.stepId);
    if (!step) {
      const validIds = (plan.steps ?? []).map((s) => s.stepId).join(', ');
      return this.text(
        `Unknown stepId "${params.stepId}" for plan ${params.planId}. ` +
          `Valid stepIds: ${validIds || '(none)'}. Record results only for ` +
          `steps that exist in the approved plan.`,
      );
    }

    // First recorded step on an approved plan starts execution.
    if (plan.status === 'approved') {
      await this.transition(params.planId, 'executing', agent.id);
    }

    // Composer citation id contract (composer.types.ts): the marker id IS
    // the citation id — itemId, or `${itemId}#${chunkId}` for chunk-level.
    const citations: Citation[] = (params.citations ?? []).map((c) => ({
      id: c.chunkId ? `${c.itemId}#${c.chunkId}` : c.itemId,
      itemId: c.itemId,
      chunkId: c.chunkId,
      searchId: c.searchId,
      auditId: params.auditId,
    }));

    const state = this.registry.recordStep(
      params.planId,
      params.stepId,
      params.summary,
      citations,
      params.auditId,
    );

    const searchIds = [
      ...new Set(citations.map((c) => c.searchId).filter((s): s is string => !!s)),
    ];
    await postAgentAudit(this.gateway, agent, req, organizationId, {
      action: 'plan_step_recorded',
      resourceType: 'agent_plan_step',
      resourceId: params.stepId,
      category: agent.id,
      details: params.summary.slice(0, 2000),
      planId: params.planId,
      stepId: params.stepId,
      provenance: {
        itemIds: citations.map((c) => c.itemId),
        searchIds: searchIds.length > 0 ? searchIds : undefined,
        auditIds: params.auditId ? [params.auditId] : undefined,
      },
    });

    const allIds = state.citations.map((c) => c.id).join(', ');
    return this.text(
      `Step "${params.stepId}" recorded for plan ${params.planId} ` +
        `(${citations.length} citation(s) registered). Citation ids now ` +
        `valid for compose_answer markers: ${allIds || '(none yet)'}.`,
    );
  }

  // ===========================================================================
  // compose_answer
  // ===========================================================================

  @Tool({
    name: 'compose_answer',
    description:
      'Submit the operator-facing answer draft for citation verification. ' +
      'Every factual claim must carry a [claim text](cite:<citationId>) ' +
      'marker whose id was registered via record_step_result. Invalid drafts ' +
      'get structured feedback (bounded re-asks); a verified draft closes ' +
      'the plan and returns the final text plus the citation map.',
    parameters: z.object({
      planId: z.string().min(1).describe('The plan id'),
      draft: z
        .string()
        .min(1)
        .describe(
          'Answer draft with inline [claim](cite:<citationId>) markers, ' +
            'grounded only in recorded step outputs',
        ),
      authContext: authContextParam,
    }),
  })
  async composeAnswer(
    params: { planId: string; draft: string; authContext?: string },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'compose_answer');
    const organizationId = requireOrganizationId(
      req,
      agent,
      params.authContext,
    );

    const plan = await this.fetchPlanForAgent(
      params.planId,
      agent,
      organizationId,
    );

    if (plan.status === 'draft') {
      return this.text(
        `Plan ${params.planId} is still in status "draft" — it must be ` +
          `approved and its steps executed (with record_step_result) before ` +
          `composing. Poll get_plan and wait for approval.`,
      );
    }
    if (plan.status === 'done' || plan.status === 'aborted') {
      return this.text(
        `Plan ${params.planId} is "${plan.status}" — its answer can no ` +
          `longer be composed. Submit a new plan if more work is needed.`,
      );
    }

    const state = this.registry.get(params.planId);
    if (!state || state.citations.length === 0) {
      return this.text(
        `No citations are recorded for plan ${params.planId}. You must ` +
          `execute the plan steps and record each result with ` +
          `record_step_result — including the citations from the tool ` +
          `outputs — before composing the answer. Only recorded citation ` +
          `ids are valid compose_answer markers.`,
      );
    }

    const verification = this.composer.verifyDraft(
      params.draft,
      state.citations,
    );

    if (!verification.valid && state.composeAttempts < COMPOSE_MAX_ATTEMPTS) {
      const attempt = this.registry.incrementComposeAttempts(params.planId);
      this.logger.debug(
        `compose_answer re-ask ${attempt}/${COMPOSE_MAX_ATTEMPTS} for plan ` +
          `${params.planId}`,
      );
      // Byte-identical to ComposerService.compose's re-ask feedback.
      const feedback = this.composer.buildFeedback(
        verification,
        state.citations,
      );
      return this.text(
        `${feedback}\n\nThen call compose_answer again with the corrected ` +
          `draft (attempt ${attempt} of ${COMPOSE_MAX_ATTEMPTS} re-asks used).`,
      );
    }

    let finalText: string;
    let removedClaims: string[] = [];
    if (verification.valid) {
      finalText = params.draft;
    } else {
      // Re-asks exhausted: strip the still-ungrounded sentences and surface
      // the omission to the operator explicitly (§3.5 step 3).
      const stripped = this.composer.stripOffendingSentences(
        params.draft,
        verification,
      );
      finalText = stripped.text;
      removedClaims = stripped.removedClaims;
      this.logger.warn(
        `compose_answer stripped ${removedClaims.length} ungrounded ` +
          `claim(s) from plan ${params.planId} after ` +
          `${state.composeAttempts} re-ask(s)`,
      );
    }

    const citationMap = this.composer.buildCitationMap(
      finalText,
      state.citations,
    );

    await this.transition(params.planId, 'done', agent.id);

    const resultHash = createHash('sha256').update(finalText).digest('hex');
    const citedItemIds = [
      ...new Set(Object.values(citationMap).map((c) => c.itemId)),
    ];
    await postAgentAudit(this.gateway, agent, req, organizationId, {
      action: 'plan_completed',
      resourceType: 'agent_plan',
      resourceId: params.planId,
      category: agent.id,
      details:
        removedClaims.length > 0
          ? `${removedClaims.length} ungrounded claim(s) removed after ` +
            `${state.composeAttempts} re-ask(s)`
          : 'answer verified: every claim resolved to recorded citations',
      planId: params.planId,
      provenance: { itemIds: citedItemIds },
      resultHash,
    });

    this.registry.delete(params.planId);

    if (removedClaims.length > 0) {
      return this.text(
        JSON.stringify(
          {
            finalText,
            removedClaims,
            citationMap,
            note:
              `${removedClaims.length} statement(s) could not be grounded ` +
              `in retrieved evidence and were removed`,
          },
          null,
          2,
        ),
      );
    }
    return this.text(JSON.stringify({ finalText, citationMap }, null, 2));
  }

  // ===========================================================================
  // abort_plan
  // ===========================================================================

  @Tool({
    name: 'abort_plan',
    description:
      'Abort a plan that should not (or can no longer) proceed. Legal from ' +
      'draft, approved, and executing. The reason is recorded in the audit trail.',
    parameters: z.object({
      planId: z.string().min(1).describe('The plan id to abort'),
      reason: z
        .string()
        .min(1)
        .max(2000)
        .describe('Why the plan is being aborted'),
      authContext: authContextParam,
    }),
  })
  async abortPlan(
    params: { planId: string; reason: string; authContext?: string },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'abort_plan');
    const organizationId = requireOrganizationId(
      req,
      agent,
      params.authContext,
    );

    const plan = await this.fetchPlanForAgent(
      params.planId,
      agent,
      organizationId,
    );

    try {
      await this.gateway.updateAgentPlanStatus(
        params.planId,
        'aborted',
        agent.id,
      );
    } catch (err) {
      if (this.isConflict(err)) {
        return this.text(
          `Plan ${params.planId} cannot be aborted: the backend rejected ` +
            `the transition from its current status "${plan.status}" ` +
            `(HTTP 409). ${LEGAL_TRANSITIONS_HINT} A plan that is already ` +
            `done or aborted stays that way.`,
        );
      }
      throw err;
    }

    await postAgentAudit(this.gateway, agent, req, organizationId, {
      action: 'plan_aborted',
      resourceType: 'agent_plan',
      resourceId: params.planId,
      category: agent.id,
      details: `reason: ${params.reason}`.slice(0, 2000),
      planId: params.planId,
    });

    this.registry.delete(params.planId);

    return this.text(
      `Plan ${params.planId} aborted. Reason recorded in the audit trail: ` +
        `${params.reason}`,
    );
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  private text(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  /**
   * Fetches the persisted plan and pins it to the REQUEST organization
   * (the deploy pin in static mode, the verified authContext org in
   * dynamic mode), fail-closed: a missing/foreign organizationId is a
   * ForbiddenException (planId is LLM-supplied — same posture as
   * CaseContextService for caseId).
   */
  private async fetchPlanForAgent(
    planId: string,
    agent: AgentIdentity,
    requestOrganizationId: string,
  ): Promise<PersistedAgentPlan> {
    const plan = await this.gateway.getAgentPlan<PersistedAgentPlan>(planId);
    if (!plan) {
      throw new Error(`Plan "${planId}" was not found.`);
    }
    if (
      !plan.organizationId ||
      plan.organizationId !== requestOrganizationId
    ) {
      throw new ForbiddenException(
        `Plan "${planId}" does not belong to the organization governing ` +
          `this call by agent "${agent.id}". Refusing to operate on it.`,
      );
    }
    return plan;
  }

  /** Status transition with a readable surface for backend 409s. */
  private async transition(
    planId: string,
    status: PlanStatus,
    by: string,
  ): Promise<void> {
    try {
      await this.gateway.updateAgentPlanStatus(planId, status, by);
    } catch (err) {
      if (this.isConflict(err)) {
        throw new Error(
          `Plan ${planId} could not transition to "${status}": the backend ` +
            `rejected it as an illegal status transition (HTTP 409). ` +
            `${LEGAL_TRANSITIONS_HINT} Call get_plan to see the current status.`,
        );
      }
      throw err;
    }
  }

  /** GatewayClientService folds HTTP errors into Error messages containing
   *  the status code (`... : 409 <message>`). */
  private isConflict(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /\b409\b/.test(message);
  }
}
