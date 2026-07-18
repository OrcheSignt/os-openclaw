import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { Context } from '@rekog/mcp-nest';
import { AUTH_CONTEXT_SCOPE } from '../../security/auth-context.service.js';
import { PlannerTools } from './planner.tools.js';
import { ComposerService } from '../../planner/composer.service.js';
import { PlanExecutionRegistry } from '../../planner/plan-execution-registry.js';
import type { AgentIdentity } from '../../security/agent-identity.service.js';
import type { McpToolHttpRequest } from '../../security/agent-context.js';
import type { GatewayClientService } from '../../gateway-client/gateway-client.service.js';
import type { CaseContextService } from '../../security/case-context.service.js';
import type { PlanStatus } from '../../planner/plan-dsl.js';

const ORG = 'org-1';
const AGENT: AgentIdentity = {
  id: 'ediscovery',
  organizationId: ORG,
  allow: new Set([
    'submit_plan',
    'get_plan',
    'record_step_result',
    'compose_answer',
    'abort_plan',
  ]),
};

const STEPS = [
  {
    stepId: 's1',
    tool: 'search_evidence',
    params: { caseId: 'case-1', query: 'Q3 wire' },
    successCriterion: 'Returns >= 1 communication item',
    dependsOn: [],
  },
  {
    stepId: 's2',
    tool: 'tag_items',
    params: { caseId: 'case-1', tagName: 'eDiscovery/Relevant' },
    successCriterion: 'Responsive items tagged',
    dependsOn: ['s1'],
  },
];

interface GatewayMock {
  createAgentPlan: jest.Mock;
  updateAgentPlanStatus: jest.Mock;
  getAgentPlan: jest.Mock;
  persistStepResult: jest.Mock;
  persistAnswer: jest.Mock;
  post: jest.Mock;
}

function makeGateway(): GatewayMock {
  return {
    createAgentPlan: jest.fn().mockResolvedValue({}),
    updateAgentPlanStatus: jest.fn().mockResolvedValue({}),
    getAgentPlan: jest.fn(),
    persistStepResult: jest.fn().mockResolvedValue({}),
    persistAnswer: jest.fn().mockResolvedValue({}),
    post: jest.fn().mockResolvedValue({}),
  };
}

function persistedPlan(planId: string, status: PlanStatus) {
  return {
    planId,
    caseId: 'case-1',
    agentId: AGENT.id,
    intent: 'Find communications about the Q3 wire and tag the responsive ones',
    steps: STEPS,
    status,
    organizationId: ORG,
  };
}

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function extractPlanId(text: string): string {
  const match = /Plan ([0-9a-f-]{36})/.exec(text);
  if (!match) throw new Error(`No planId in: ${text}`);
  return match[1];
}

describe('PlannerTools', () => {
  let gateway: GatewayMock;
  let caseContext: { requireCaseContext: jest.Mock };
  let registry: PlanExecutionRegistry;
  let tools: PlannerTools;
  const ctx = {} as Context;
  let req: McpToolHttpRequest;

  beforeEach(() => {
    gateway = makeGateway();
    caseContext = {
      requireCaseContext: jest
        .fn()
        .mockResolvedValue({ caseId: 'case-1', organizationId: ORG }),
    };
    registry = new PlanExecutionRegistry();
    tools = new PlannerTools(
      gateway as unknown as GatewayClientService,
      caseContext as unknown as CaseContextService,
      new ComposerService(),
      registry,
    );
    req = { openClawAgent: AGENT, headers: {} };
    delete process.env.OPENCLAW_PLAN_AUTOAPPROVE;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_PLAN_AUTOAPPROVE;
  });

  async function submitValidPlan(): Promise<string> {
    const result = await tools.submitPlan(
      {
        caseId: 'case-1',
        intent: 'Find communications about the Q3 wire and tag the responsive ones',
        steps: STEPS,
      },
      ctx,
      req,
    );
    return extractPlanId(resultText(result));
  }

  // ---------------------------------------------------------------------------
  // happy path: submit -> auto-approve -> record -> compose
  // ---------------------------------------------------------------------------

  it('runs the full lifecycle: submit, auto-approve, record steps, compose', async () => {
    process.env.OPENCLAW_PLAN_AUTOAPPROVE = 'true';

    // -- submit (auto-approved by the SERVER, by: system:auto-approve) --
    const planId = await submitValidPlan();

    expect(caseContext.requireCaseContext).toHaveBeenCalledWith(
      req,
      'case-1',
      undefined,
    );
    expect(gateway.createAgentPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId,
        caseId: 'case-1',
        agentId: AGENT.id,
        status: 'draft',
      }),
      ORG,
      AGENT.id,
      // static mode (no authContext token) -> no runId correlation key
      undefined,
    );
    expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
      planId,
      'approved',
      'system:auto-approve',
    );
    expect(gateway.post).toHaveBeenCalledWith(
      'project',
      '/audit-logs',
      expect.objectContaining({ action: 'plan_submitted', planId }),
    );
    expect(gateway.post).toHaveBeenCalledWith(
      'project',
      '/audit-logs',
      expect.objectContaining({ action: 'plan_auto_approved', planId }),
    );

    // -- record step on the approved plan: approved -> executing --
    gateway.getAgentPlan.mockResolvedValue(persistedPlan(planId, 'approved'));
    const recorded = await tools.recordStepResult(
      {
        planId,
        stepId: 's1',
        summary: 'Found 2 communications between A and B about the Q3 wire',
        citations: [
          { itemId: 'item-1', searchId: 'search-9' },
          { itemId: 'item-2', chunkId: 'chunk-3' },
        ],
        auditId: 'audit-41',
      },
      ctx,
      req,
    );

    expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
      planId,
      'executing',
      AGENT.id,
    );
    // citation id contract: itemId, or itemId#chunkId for chunk-level
    expect(resultText(recorded)).toContain('item-1');
    expect(resultText(recorded)).toContain('item-2#chunk-3');
    expect(gateway.post).toHaveBeenCalledWith(
      'project',
      '/audit-logs',
      expect.objectContaining({
        action: 'plan_step_recorded',
        planId,
        stepId: 's1',
        provenance: expect.objectContaining({
          itemIds: ['item-1', 'item-2'],
          searchIds: ['search-9'],
          auditIds: ['audit-41'],
        }),
      }),
    );
    // durable step-result persisted with status 'done' and the recorded
    // citation ids for this step (does not change plan status)
    expect(gateway.persistStepResult).toHaveBeenCalledWith(
      planId,
      ORG,
      expect.objectContaining({
        stepId: 's1',
        status: 'done',
        summary: 'Found 2 communications between A and B about the Q3 wire',
        citationIds: ['item-1', 'item-2#chunk-3'],
        auditId: 'audit-41',
      }),
    );

    // -- compose a fully-grounded draft: executing -> done --
    gateway.getAgentPlan.mockResolvedValue(persistedPlan(planId, 'executing'));
    const composed = await tools.composeAnswer(
      {
        planId,
        draft:
          '[Alice emailed Bob about the Q3 wire on March 4](cite:item-1). ' +
          '[Bob confirmed the transfer details](cite:item-2#chunk-3).',
      },
      ctx,
      req,
    );

    const payload = JSON.parse(resultText(composed));
    expect(payload.finalText).toContain('(cite:item-1)');
    expect(payload.citationMap['item-1']).toMatchObject({ itemId: 'item-1' });
    expect(payload.citationMap['item-2#chunk-3']).toMatchObject({
      itemId: 'item-2',
      chunkId: 'chunk-3',
    });
    expect(payload.removedClaims).toBeUndefined();

    expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
      planId,
      'done',
      AGENT.id,
    );
    expect(gateway.post).toHaveBeenCalledWith(
      'project',
      '/audit-logs',
      expect.objectContaining({
        action: 'plan_completed',
        planId,
        resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    // durable answer persisted on the done path (status transition above
    // remains the source of truth; this is additive)
    expect(gateway.persistAnswer).toHaveBeenCalledWith(
      planId,
      ORG,
      expect.objectContaining({
        answer: payload.finalText,
        citationMap: expect.objectContaining({
          'item-1': expect.objectContaining({ itemId: 'item-1' }),
        }),
        removedClaims: [],
      }),
    );
    // registry cleaned up after completion
    expect(registry.get(planId)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // submit_plan validation feedback loop
  // ---------------------------------------------------------------------------

  it('returns LLM-readable validation errors and does not persist an invalid plan', async () => {
    const badSteps = [
      { ...STEPS[0] },
      { ...STEPS[1], stepId: 's1', dependsOn: ['missing-step'] },
    ];
    const result = await tools.submitPlan(
      { caseId: 'case-1', intent: 'broken plan', steps: badSteps },
      ctx,
      req,
    );

    const text = resultText(result);
    expect(text).toContain('Plan validation failed');
    expect(text).toContain('call submit_plan again');
    expect(text).toContain('duplicate stepId "s1"');
    expect(text).toContain('unknown stepId "missing-step"');
    expect(gateway.createAgentPlan).not.toHaveBeenCalled();
    expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();

    // the re-ask loop: a corrected resubmission succeeds
    const fixed = await tools.submitPlan(
      { caseId: 'case-1', intent: 'fixed plan', steps: STEPS },
      ctx,
      req,
    );
    expect(resultText(fixed)).toContain('submitted');
    expect(gateway.createAgentPlan).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the case context org check rejects the caseId', async () => {
    caseContext.requireCaseContext.mockRejectedValue(
      new ForbiddenException('org mismatch'),
    );
    await expect(
      tools.submitPlan(
        { caseId: 'case-other-org', intent: 'x', steps: STEPS },
        ctx,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.createAgentPlan).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // self-approval impossibility
  // ---------------------------------------------------------------------------

  describe('self-approval is impossible', () => {
    it('exposes no approval tool of any kind', () => {
      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(tools),
      ).filter((name) => typeof (tools as any)[name] === 'function');
      expect(methods.some((m) => /approve/i.test(m))).toBe(false);
    });

    it('leaves the plan in draft when OPENCLAW_PLAN_AUTOAPPROVE is not true', async () => {
      process.env.OPENCLAW_PLAN_AUTOAPPROVE = 'false';
      const planId = await submitValidPlan();

      expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();
      const result = await tools.submitPlan(
        { caseId: 'case-1', intent: 'again', steps: STEPS },
        ctx,
        req,
      );
      expect(resultText(result)).toContain('operator approval is pending');
      expect(resultText(result)).toContain('You cannot approve your own plan');
      void planId;
    });

    it('record_step_result refuses to execute against a draft plan', async () => {
      const planId = await submitValidPlan();
      gateway.getAgentPlan.mockResolvedValue(persistedPlan(planId, 'draft'));

      const result = await tools.recordStepResult(
        { planId, stepId: 's1', summary: 'tried anyway', citations: [] },
        ctx,
        req,
      );

      expect(resultText(result)).toContain('operator approval is pending');
      expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();
      // nothing registered: composing later still requires recorded citations
      expect(registry.get(planId)?.citations ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // record_step_result guards
  // ---------------------------------------------------------------------------

  it('rejects an unknown stepId, naming the valid stepIds', async () => {
    gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'approved'));
    const result = await tools.recordStepResult(
      { planId: 'p1', stepId: 's99', summary: 'no such step', citations: [] },
      ctx,
      req,
    );
    const text = resultText(result);
    expect(text).toContain('Unknown stepId "s99"');
    expect(text).toContain('Valid stepIds: s1, s2');
    expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();
  });

  it('refuses step results on done/aborted plans', async () => {
    gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'aborted'));
    const result = await tools.recordStepResult(
      { planId: 'p1', stepId: 's1', summary: 'late', citations: [] },
      ctx,
      req,
    );
    expect(resultText(result)).toContain('"aborted"');
    expect(resultText(result)).toContain('no further step results');
  });

  it('fails closed when the plan belongs to a different organization', async () => {
    gateway.getAgentPlan.mockResolvedValue({
      ...persistedPlan('p1', 'approved'),
      organizationId: 'org-evil',
    });
    await expect(
      tools.getPlan({ planId: 'p1' }, ctx, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ---------------------------------------------------------------------------
  // compose_answer: fabricated citations, feedback, exhaustion stripping
  // ---------------------------------------------------------------------------

  describe('compose_answer citation gate', () => {
    const planId = 'plan-compose';

    beforeEach(async () => {
      gateway.getAgentPlan.mockResolvedValue(persistedPlan(planId, 'approved'));
      await tools.recordStepResult(
        {
          planId,
          stepId: 's1',
          summary: 'found item-1',
          citations: [{ itemId: 'item-1', searchId: 'search-1' }],
        },
        ctx,
        req,
      );
      gateway.getAgentPlan.mockResolvedValue(
        persistedPlan(planId, 'executing'),
      );
      gateway.updateAgentPlanStatus.mockClear();
    });

    const fabricated =
      '[Alice emailed Bob about the wire](cite:item-1). ' +
      '[Bob fled the country the next morning](cite:c404).';

    it('returns ComposerService re-ask feedback for a fabricated citation id', async () => {
      const result = await tools.composeAnswer(
        { planId, draft: fabricated },
        ctx,
        req,
      );
      const text = resultText(result);
      // exact composer feedback ingredients
      expect(text).toContain('Your draft failed citation verification');
      expect(text).toContain(
        'claim "Bob fled the country the next morning" cites "c404"',
      );
      expect(text).toContain('Valid citation ids: item-1');
      // plan NOT closed
      expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();
      expect(registry.get(planId)?.composeAttempts).toBe(1);
    });

    it('strips ungrounded claims after attempts are exhausted and closes the plan', async () => {
      await tools.composeAnswer({ planId, draft: fabricated }, ctx, req); // attempt 1
      await tools.composeAnswer({ planId, draft: fabricated }, ctx, req); // attempt 2
      const result = await tools.composeAnswer(
        { planId, draft: fabricated },
        ctx,
        req,
      ); // exhausted -> strip

      const payload = JSON.parse(resultText(result));
      expect(payload.finalText).toBe(
        '[Alice emailed Bob about the wire](cite:item-1).',
      );
      expect(payload.removedClaims).toEqual([
        'Bob fled the country the next morning.',
      ]);
      expect(payload.note).toBe(
        '1 statement(s) could not be grounded in retrieved evidence and were removed',
      );
      expect(payload.citationMap['item-1']).toMatchObject({
        itemId: 'item-1',
      });

      expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
        planId,
        'done',
        AGENT.id,
      );
      expect(gateway.post).toHaveBeenCalledWith(
        'project',
        '/audit-logs',
        expect.objectContaining({
          action: 'plan_completed',
          planId,
          resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      );
      expect(registry.get(planId)).toBeNull();
    });
  });

  it('instructs the agent to record step results before composing', async () => {
    gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'executing'));
    const result = await tools.composeAnswer(
      { planId: 'p1', draft: '[claim](cite:item-1).' },
      ctx,
      req,
    );
    expect(resultText(result)).toContain('No citations are recorded');
    expect(resultText(result)).toContain('record_step_result');
    expect(gateway.updateAgentPlanStatus).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // abort_plan
  // ---------------------------------------------------------------------------

  describe('abort_plan', () => {
    it('aborts a live plan, audits the reason, and clears the registry', async () => {
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'executing'));
      registry.getOrCreate('p1');

      const result = await tools.abortPlan(
        { planId: 'p1', reason: 'operator withdrew the request' },
        ctx,
        req,
      );

      expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
        'p1',
        'aborted',
        AGENT.id,
      );
      expect(gateway.post).toHaveBeenCalledWith(
        'project',
        '/audit-logs',
        expect.objectContaining({
          action: 'plan_aborted',
          planId: 'p1',
          details: 'reason: operator withdrew the request',
        }),
      );
      expect(resultText(result)).toContain('aborted');
      expect(registry.get('p1')).toBeNull();
    });

    it('surfaces a backend 409 as a readable illegal-transition message', async () => {
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'done'));
      gateway.updateAgentPlanStatus.mockRejectedValue(
        new Error(
          'Gateway call failed (investigation/internal/agent-plans/p1/status): 409 Illegal status transition',
        ),
      );

      const result = await tools.abortPlan(
        { planId: 'p1', reason: 'too late' },
        ctx,
        req,
      );

      const text = resultText(result);
      expect(text).toContain('cannot be aborted');
      expect(text).toContain('"done"');
      expect(text).toContain('Legal transitions');
      // no abort audit on a failed transition
      expect(gateway.post).not.toHaveBeenCalledWith(
        'project',
        '/audit-logs',
        expect.objectContaining({ action: 'plan_aborted' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // v2 chat refactor: durable run persistence (runId + step/answer writes)
  // ---------------------------------------------------------------------------

  describe('durable run persistence', () => {
    it('passes runId=undefined in static mode (no authContext) without breaking', async () => {
      // req carries only the static-pinned agent — no authContext token.
      const planId = await submitValidPlan();
      expect(gateway.createAgentPlan).toHaveBeenCalledWith(
        expect.objectContaining({ planId }),
        ORG,
        AGENT.id,
        undefined,
      );
    });

    it('record_step_result persistence failure does not fail the tool', async () => {
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'approved'));
      gateway.persistStepResult.mockRejectedValue(new Error('boom'));

      const result = await tools.recordStepResult(
        {
          planId: 'p1',
          stepId: 's1',
          summary: 'found item-1',
          citations: [{ itemId: 'item-1' }],
        },
        ctx,
        req,
      );

      // tool still succeeds: in-memory registry is authoritative for compose
      expect(gateway.persistStepResult).toHaveBeenCalled();
      expect(resultText(result)).toContain('recorded for plan p1');
      expect(registry.get('p1')?.citations).toHaveLength(1);
    });

    it('compose_answer answer persistence failure does not fail the tool', async () => {
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p2', 'approved'));
      await tools.recordStepResult(
        {
          planId: 'p2',
          stepId: 's1',
          summary: 'found item-1',
          citations: [{ itemId: 'item-1' }],
        },
        ctx,
        req,
      );
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p2', 'executing'));
      gateway.persistAnswer.mockRejectedValue(new Error('boom'));

      const result = await tools.composeAnswer(
        { planId: 'p2', draft: '[Alice emailed Bob](cite:item-1).' },
        ctx,
        req,
      );

      // status transition committed and answer returned despite persist failure
      expect(gateway.updateAgentPlanStatus).toHaveBeenCalledWith(
        'p2',
        'done',
        AGENT.id,
      );
      expect(gateway.persistAnswer).toHaveBeenCalled();
      const payload = JSON.parse(resultText(result));
      expect(payload.finalText).toContain('(cite:item-1)');
      expect(registry.get('p2')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // identity / allowlist enforcement
  // ---------------------------------------------------------------------------

  it('fails closed without an agent identity on the request', async () => {
    await expect(
      tools.getPlan({ planId: 'p1' }, ctx, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('enforces the per-agent allowlist on every planner tool', async () => {
    const restricted: AgentIdentity = {
      id: 'privacy',
      organizationId: ORG,
      allow: new Set(['search_evidence']),
    };
    const restrictedReq: McpToolHttpRequest = {
      openClawAgent: restricted,
      headers: {},
    };
    await expect(
      tools.submitPlan(
        { caseId: 'case-1', intent: 'x', steps: STEPS },
        ctx,
        restrictedReq,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      tools.composeAnswer({ planId: 'p1', draft: 'x' }, ctx, restrictedReq),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ---------------------------------------------------------------------------
  // dynamic org binding (authContext)
  // ---------------------------------------------------------------------------

  describe('dynamic org binding (authContext)', () => {
    const SECRET = 'unit-test-jwt-secret-at-least-32-characters!!';
    const TOKEN_ORG = '777777777777777777777777';
    const DYNAMIC_AGENT: AgentIdentity = {
      id: AGENT.id,
      organizationId: null,
      allow: AGENT.allow,
    };
    let prevSecret: string | undefined;
    let dynReq: McpToolHttpRequest;

    beforeAll(() => {
      prevSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = SECRET;
    });

    afterAll(() => {
      if (prevSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevSecret;
    });

    beforeEach(() => {
      dynReq = { openClawAgent: DYNAMIC_AGENT, headers: {} };
    });

    function mintToken(org = TOKEN_ORG): string {
      return jwt.sign(
        { sub: 'user-7', org, scope: AUTH_CONTEXT_SCOPE, jti: 'jti-77' },
        SECRET,
        { algorithm: 'HS256', expiresIn: 600 },
      );
    }

    it('checks the persisted plan org against the TOKEN org, not agent state', async () => {
      gateway.getAgentPlan.mockResolvedValue({
        ...persistedPlan('p1', 'approved'),
        organizationId: TOKEN_ORG,
      });
      const result = await tools.getPlan(
        { planId: 'p1', authContext: mintToken() },
        ctx,
        dynReq,
      );
      expect(resultText(result)).toContain('"planId": "p1"');
    });

    it('rejects a plan persisted under a different org even with a valid token', async () => {
      // persistedPlan carries ORG ('org-1'), the token carries TOKEN_ORG
      gateway.getAgentPlan.mockResolvedValue(persistedPlan('p1', 'approved'));
      await expect(
        tools.getPlan({ planId: 'p1', authContext: mintToken() }, ctx, dynReq),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('fails closed when a planner tool is called without authContext', async () => {
      await expect(
        tools.getPlan({ planId: 'p1' }, ctx, dynReq),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(gateway.getAgentPlan).not.toHaveBeenCalled();
    });

    it('persists submitted plans under the token org and audits the user', async () => {
      const token = mintToken();
      caseContext.requireCaseContext.mockResolvedValue({
        caseId: 'case-1',
        organizationId: TOKEN_ORG,
      });

      const result = await tools.submitPlan(
        {
          caseId: 'case-1',
          intent: 'Find the Q3 wire communications for the token org',
          steps: STEPS,
          authContext: token,
        },
        ctx,
        dynReq,
      );
      const planId = extractPlanId(resultText(result));

      expect(caseContext.requireCaseContext).toHaveBeenCalledWith(
        dynReq,
        'case-1',
        token,
      );
      // runId correlation key = the verified authContext jti
      expect(gateway.createAgentPlan).toHaveBeenCalledWith(
        expect.objectContaining({ planId, caseId: 'case-1' }),
        TOKEN_ORG,
        AGENT.id,
        'jti-77',
      );
      expect(gateway.post).toHaveBeenCalledWith(
        'project',
        '/audit-logs',
        expect.objectContaining({
          action: 'plan_submitted',
          organizationId: TOKEN_ORG,
          actor: expect.objectContaining({
            agentId: AGENT.id,
            userId: 'user-7',
            authContextJti: 'jti-77',
          }),
        }),
      );
    });
  });
});
