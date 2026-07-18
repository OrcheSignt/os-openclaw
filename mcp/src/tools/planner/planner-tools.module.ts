import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { PlannerModule } from '../../planner/planner.module.js';
import { PlannerTools } from './planner.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

/**
 * v2.0 planner runtime tool family (submit_plan / get_plan /
 * record_step_result / compose_answer / abort_plan).
 * ComposerService + PlanExecutionRegistry come from PlannerModule;
 * GatewayClientService and CaseContextService resolve through the
 * @Global() GatewayClientModule / SecurityModule.
 *
 * forFeature registers PlannerTools' @Tool methods with the forRoot server
 * (see EvidenceToolsModule for why this is required).
 */
@Module({
  imports: [PlannerModule, McpModule.forFeature([PlannerTools], MCP_SERVER_NAME)],
  providers: [PlannerTools],
})
export class PlannerToolsModule {}
