import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { PipelineTools } from './pipeline.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

@Module({
  imports: [McpModule.forFeature([PipelineTools], MCP_SERVER_NAME)],
  providers: [PipelineTools],
})
export class PipelineToolsModule {}
