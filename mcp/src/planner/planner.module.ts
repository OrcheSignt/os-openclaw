import { Module } from '@nestjs/common';
import { ComposerService } from './composer.service.js';

/**
 * WS-3/WS-4 planner runtime building blocks:
 *  - ComposerService (citation gate, §3.5) as an injectable provider;
 *  - the plan DSL (pure functions/schemas) re-exported below for direct
 *    import by the planner runtime and tool handlers.
 * Plan persistence goes through GatewayClientService (global module).
 */
@Module({
  providers: [ComposerService],
  exports: [ComposerService],
})
export class PlannerModule {}

export * from './plan-dsl.js';
export * from './composer.types.js';
export { ComposerService } from './composer.service.js';
