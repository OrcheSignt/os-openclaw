import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { ReportingTools } from './reporting.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

@Module({
  imports: [McpModule.forFeature([ReportingTools], MCP_SERVER_NAME)],
  providers: [ReportingTools],
})
export class ReportingToolsModule {}
