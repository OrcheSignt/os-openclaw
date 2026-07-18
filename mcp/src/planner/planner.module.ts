import { Module } from '@nestjs/common';
import { ComposerService } from './composer.service.js';
import { PlanExecutionRegistry } from './plan-execution-registry.js';

/**
 * WS-3/WS-4 planner runtime building blocks:
 *  - ComposerService (citation gate, §3.5) as an injectable provider;
 *  - PlanExecutionRegistry (per-pod step-result/citation state driving the
 *    planner tool family);
 *  - the plan DSL (pure functions/schemas) re-exported below for direct
 *    import by the planner runtime and tool handlers.
 * Plan persistence goes through GatewayClientService (global module).
 */
@Module({
  providers: [ComposerService, PlanExecutionRegistry],
  exports: [ComposerService, PlanExecutionRegistry],
})
export class PlannerModule {}

export * from './plan-dsl.js';
export * from './composer.types.js';
export { ComposerService } from './composer.service.js';
export { PlanExecutionRegistry } from './plan-execution-registry.js';
