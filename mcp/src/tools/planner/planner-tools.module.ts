import { Module } from '@nestjs/common';
import { PlannerModule } from '../../planner/planner.module.js';
import { PlannerTools } from './planner.tools.js';

/**
 * v2.0 planner runtime tool family (submit_plan / get_plan /
 * record_step_result / compose_answer / abort_plan).
 * ComposerService + PlanExecutionRegistry come from PlannerModule;
 * GatewayClientService and CaseContextService resolve through the
 * @Global() GatewayClientModule / SecurityModule.
 */
@Module({
  imports: [PlannerModule],
  providers: [PlannerTools],
})
export class PlannerToolsModule {}
