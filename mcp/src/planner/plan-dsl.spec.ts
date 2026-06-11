import { validatePlan, type AgentPlan } from './plan-dsl.js';

const VALID_PLAN = {
  planId: 'f6a7c9e2-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  caseId: 'case-123',
  agentId: 'ediscovery',
  intent:
    'Find communications between Alice and Bob about the Q3 wire and tag the responsive ones',
  steps: [
    {
      stepId: 's1',
      tool: 'search_evidence',
      params: { query: 'Alice Bob Q3 wire' },
      successCriterion: 'At least one communication item returned',
      dependsOn: [],
    },
    {
      stepId: 's2',
      tool: 'get_item_details',
      params: { itemId: '$s1.results[0].id' },
      successCriterion: 'Item details retrieved with content',
      dependsOn: ['s1'],
    },
    {
      stepId: 's3',
      tool: 'tag_items',
      params: { tag: 'responsive' },
      successCriterion: 'Responsive items tagged',
      dependsOn: ['s1', 's2'],
    },
  ],
  status: 'draft',
};

function clone(): any {
  return JSON.parse(JSON.stringify(VALID_PLAN));
}

describe('validatePlan', () => {
  it('accepts a valid plan and returns the parsed document', () => {
    const result = validatePlan(VALID_PLAN);
    expect(result.ok).toBe(true);
    const plan = (result as { ok: true; plan: AgentPlan }).plan;
    expect(plan.planId).toBe(VALID_PLAN.planId);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[2].dependsOn).toEqual(['s1', 's2']);
  });

  it('defaults a missing dependsOn to an empty array', () => {
    const input = clone();
    delete input.steps[0].dependsOn;
    const result = validatePlan(input);
    expect(result.ok).toBe(true);
    const plan = (result as { ok: true; plan: AgentPlan }).plan;
    expect(plan.steps[0].dependsOn).toEqual([]);
  });

  it('rejects duplicate stepIds with an LLM-readable error', () => {
    const input = clone();
    input.steps[2].stepId = 's1';
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    expect(errors.some((e) => e.includes('duplicate stepId "s1"'))).toBe(true);
    expect(errors.some((e) => e.startsWith('steps.2.stepId'))).toBe(true);
  });

  it('rejects dangling dependsOn references', () => {
    const input = clone();
    input.steps[1].dependsOn = ['does-not-exist'];
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    expect(
      errors.some((e) =>
        e.includes('depends on unknown stepId "does-not-exist"'),
      ),
    ).toBe(true);
    expect(errors.some((e) => e.startsWith('steps.1.dependsOn.0'))).toBe(true);
  });

  it('rejects dependency cycles', () => {
    const input = clone();
    input.steps[0].dependsOn = ['s3']; // s1 -> s3 -> s2 -> s1
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    const cycleError = errors.find((e) => e.includes('dependency cycle'));
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain('s1');
    expect(cycleError).toContain('s2');
    expect(cycleError).toContain('s3');
  });

  it('rejects a step that depends on itself', () => {
    const input = clone();
    input.steps[0].dependsOn = ['s1'];
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    expect(errors.some((e) => e.includes('dependency cycle'))).toBe(true);
  });

  it('rejects an empty steps array', () => {
    const input = clone();
    input.steps = [];
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    expect(errors.some((e) => e.includes('at least one step'))).toBe(true);
  });

  it('rejects a non-uuid planId and an unknown status', () => {
    const input = clone();
    input.planId = 'not-a-uuid';
    input.status = 'paused';
    const result = validatePlan(input);
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: string[] }).errors;
    expect(errors.some((e) => e.startsWith('planId'))).toBe(true);
    expect(errors.some((e) => e.startsWith('status'))).toBe(true);
  });
});
