import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { RecommendationsTools } from './recommendations.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

@Module({
  imports: [McpModule.forFeature([RecommendationsTools], MCP_SERVER_NAME)],
  providers: [RecommendationsTools],
})
export class RecommendationsToolsModule {}
