import {
  PlanExecutionRegistry,
  PLAN_EXECUTION_MAX_ENTRIES,
  PLAN_EXECUTION_TTL_MS,
} from './plan-execution-registry.js';
import type { Citation } from './composer.types.js';

function cite(id: string): Citation {
  return { id, itemId: id };
}

describe('PlanExecutionRegistry', () => {
  let registry: PlanExecutionRegistry;
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    registry = new PlanExecutionRegistry();
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('records step results and accumulates citations across steps', () => {
    registry.recordStep('p1', 's1', 'searched', [cite('item-1'), cite('item-2')]);
    const state = registry.recordStep('p1', 's2', 'detailed', [cite('item-3')], 'audit-7');

    expect(state.citations.map((c) => c.id)).toEqual([
      'item-1',
      'item-2',
      'item-3',
    ]);
    expect(state.stepResults).toHaveLength(2);
    expect(state.stepResults[1]).toMatchObject({
      stepId: 's2',
      summary: 'detailed',
      citationIds: ['item-3'],
      auditId: 'audit-7',
    });
  });

  it('deduplicates citations by id', () => {
    registry.recordStep('p1', 's1', 'searched', [cite('item-1')]);
    const state = registry.recordStep('p1', 's2', 'detailed', [
      cite('item-1'),
      cite('item-2'),
    ]);
    expect(state.citations.map((c) => c.id)).toEqual(['item-1', 'item-2']);
  });

  it('tracks compose attempts per plan', () => {
    registry.getOrCreate('p1');
    expect(registry.incrementComposeAttempts('p1')).toBe(1);
    expect(registry.incrementComposeAttempts('p1')).toBe(2);
    expect(registry.get('p1')?.composeAttempts).toBe(2);
    // independent plans do not share counters
    expect(registry.incrementComposeAttempts('p2')).toBe(1);
  });

  it('expires entries after the TTL', () => {
    registry.recordStep('p1', 's1', 'searched', [cite('item-1')]);
    expect(registry.get('p1')).not.toBeNull();

    now += PLAN_EXECUTION_TTL_MS + 1;
    expect(registry.get('p1')).toBeNull();
    expect(registry.size).toBe(0);
  });

  it('slides the TTL on recorded activity', () => {
    registry.getOrCreate('p1');
    now += PLAN_EXECUTION_TTL_MS - 1;
    registry.recordStep('p1', 's1', 'still alive', [cite('item-1')]);

    // Past the original expiry but within the refreshed window.
    now += PLAN_EXECUTION_TTL_MS - 1;
    expect(registry.get('p1')).not.toBeNull();
  });

  it('evicts the least-recently-used entry beyond the max bound', () => {
    for (let i = 0; i < PLAN_EXECUTION_MAX_ENTRIES; i++) {
      registry.getOrCreate(`plan-${i}`);
    }
    // Touch plan-0 so plan-1 becomes the LRU candidate.
    expect(registry.get('plan-0')).not.toBeNull();

    registry.getOrCreate('plan-overflow');

    expect(registry.size).toBe(PLAN_EXECUTION_MAX_ENTRIES);
    expect(registry.get('plan-1')).toBeNull();
    expect(registry.get('plan-0')).not.toBeNull();
    expect(registry.get('plan-overflow')).not.toBeNull();
  });

  it('delete() drops the entry', () => {
    registry.getOrCreate('p1');
    registry.delete('p1');
    expect(registry.get('p1')).toBeNull();
  });
});
