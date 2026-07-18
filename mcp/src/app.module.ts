import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { McpModule, McpTransportType } from '@rekog/mcp-nest';
import { GatewayClientModule } from './gateway-client/gateway-client.module.js';
import { EvidenceToolsModule } from './tools/evidence/evidence-tools.module.js';
import { ManagementToolsModule } from './tools/management/management-tools.module.js';
import { MlToolsModule } from './tools/ml/ml-tools.module.js';
import { ReportingToolsModule } from './tools/reporting/reporting-tools.module.js';
import { PipelineToolsModule } from './tools/pipeline/pipeline-tools.module.js';
import { RecommendationsToolsModule } from './tools/recommendations/recommendations-tools.module.js';
import { PlannerToolsModule } from './tools/planner/planner-tools.module.js';
import { HealthModule } from './health/health.module.js';
import { PlannerModule } from './planner/planner.module.js';
import { SecurityModule } from './security/security.module.js';
import { McpAuthGuard } from './security/mcp-auth.guard.js';
import { MCP_SERVER_NAME } from './mcp-server.constants.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    SecurityModule,
    McpModule.forRoot({
      name: MCP_SERVER_NAME,
      version: '1.0.0',
      transport: McpTransportType.STREAMABLE_HTTP,
      mcpEndpoint: 'mcp',
      // Bearer-token auth for the /mcp transport. McpAuthGuard rejects
      // requests without a valid OPENCLAW_MCP_TOKEN_* and attaches the
      // resolved AgentIdentity to req.openClawAgent.
      guards: [McpAuthGuard],
    }),
    GatewayClientModule,
    EvidenceToolsModule,
    ManagementToolsModule,
    MlToolsModule,
    ReportingToolsModule,
    PipelineToolsModule,
    RecommendationsToolsModule,
    PlannerModule,
    PlannerToolsModule,
    HealthModule,
  ],
})
export class AppModule {}
