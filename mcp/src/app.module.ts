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
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    McpModule.forRoot({
      name: 'orchesight-mcp',
      version: '1.0.0',
      transport: McpTransportType.STREAMABLE_HTTP,
      mcpEndpoint: 'mcp',
    }),
    GatewayClientModule,
    EvidenceToolsModule,
    ManagementToolsModule,
    MlToolsModule,
    ReportingToolsModule,
    PipelineToolsModule,
    HealthModule,
  ],
})
export class AppModule {}
