import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { MlTools } from './ml.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

@Module({
  imports: [McpModule.forFeature([MlTools], MCP_SERVER_NAME)],
  providers: [MlTools],
})
export class MlToolsModule {}
