import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { EvidenceTools } from './evidence.tools.js';
import { MCP_SERVER_NAME } from '../../mcp-server.constants.js';

// forFeature registers EvidenceTools' @Tool methods with the forRoot server.
// Without it @rekog/mcp-nest only discovers tools declared directly in the
// module that imports forRoot (AppModule), so feature-module tools are missed.
@Module({
  imports: [McpModule.forFeature([EvidenceTools], MCP_SERVER_NAME)],
  providers: [EvidenceTools],
})
export class EvidenceToolsModule {}
