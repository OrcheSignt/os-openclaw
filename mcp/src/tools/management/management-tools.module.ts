import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { ManagementTools } from './management.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

@Module({
  imports: [McpModule.forFeature([ManagementTools], MCP_SERVER_NAME)],
  providers: [ManagementTools],
})
export class ManagementToolsModule {}
