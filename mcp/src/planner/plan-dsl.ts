import { z } from 'zod';

/**
 * WS-3 plan DSL — the JSON-schema'd plan document a planner agent emits.
 * Zod-validated BEFORE any dispatch; invalid plans are rejected back to the
 * LLM with the validation errors (bounded re-ask, default 2 retries — the
 * retry loop lives in the planner runtime; this module only returns
 * structured, LLM-readable errors).
 *
 * Status transitions are append-only:
 *   draft -> approved -> executing -> done | aborted
 */

export const PLAN_STATUSES = [
  'draft',
  'approved',
  'executing',
  'done',
  'aborted',
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const planStepSchema = z.object({
  stepId: z
    .string()
    .min(1, 'stepId must be a non-empty string, unique within the plan'),
  tool: z.string().min(1, 'tool must be the name of an MCP tool to call'),
  params: z.record(z.string(), z.unknown()),
  successCriterion: z
    .string()
    .min(1, 'successCriterion must describe how to judge this step succeeded'),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe('stepIds that must complete before this step runs'),
});

export const agentPlanSchema = z
  .object({
    planId: z.uuid('planId must be a UUID string'),
    caseId: z.string().min(1, 'caseId must be a non-empty string'),
    agentId: z.string().min(1, 'agentId must be a non-empty string'),
    intent: z
      .string()
      .min(1, 'intent must restate the operator request being planned for'),
    steps: z
      .array(planStepSchema)
      .min(1, 'steps must contain at least one step'),
    status: z.enum(PLAN_STATUSES),
  })
  .superRefine((plan, ctx) => {
    // 1. stepIds unique
    const firstIndexById = new Map<string, number>();
    let duplicates = false;
    plan.steps.forEach((step, i) => {
      const firstIndex = firstIndexById.get(step.stepId);
      if (firstIndex !== undefined) {
        duplicates = true;
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'stepId'],
          message:
            `duplicate stepId "${step.stepId}" — already used by ` +
            `steps[${firstIndex}]; every step needs a unique stepId`,
        });
      } else {
        firstIndexById.set(step.stepId, i);
      }
    });

    // 2. dependsOn references must exist
    let dangling = false;
    plan.steps.forEach((step, i) => {
      step.dependsOn.forEach((dep, j) => {
        if (!firstIndexById.has(dep)) {
          dangling = true;
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'dependsOn', j],
            message:
              `step "${step.stepId}" depends on unknown stepId "${dep}" — ` +
              `every dependsOn entry must reference the stepId of another ` +
              `step in this plan`,
          });
        }
      });
    });

    // 3. no dependency cycles (only meaningful once ids are unique & resolved)
    if (duplicates || dangling) return;
    const inCycle = findCycleMembers(plan.steps);
    if (inCycle.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message:
          `dependency cycle detected among steps [${inCycle.join(', ')}] — ` +
          `dependsOn must form a directed acyclic graph (a step may not ` +
          `depend on itself or on any step that depends on it)`,
      });
    }
  });

export type PlanStep = z.infer<typeof planStepSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

export type ValidatePlanResult =
  | { ok: true; plan: AgentPlan }
  | { ok: false; errors: string[] };

/**
 * Validates an LLM-emitted plan document. On failure returns LLM-readable
 * error strings (one per problem, prefixed with the JSON path) suitable for
 * feeding back to the model verbatim in a bounded re-ask.
 */
export function validatePlan(input: unknown): ValidatePlanResult {
  const parsed = agentPlanSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, plan: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map(String).join('.') : '(plan root)';
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}

/**
 * Kahn's algorithm topological check. Returns the stepIds that participate
 * in (or are downstream of) a dependency cycle; empty array means acyclic.
 * Precondition: stepIds unique and all dependsOn references resolve.
 */
function findCycleMembers(steps: ReadonlyArray<PlanStep>): string[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    inDegree.set(step.stepId, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(step.stepId);
      dependents.set(dep, list);
    }
  }

  const queue = steps
    .filter((s) => (inDegree.get(s.stepId) ?? 0) === 0)
    .map((s) => s.stepId);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    processed++;
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (processed === steps.length) return [];
  return steps
    .map((s) => s.stepId)
    .filter((id) => (inDegree.get(id) ?? 0) > 0);
}
