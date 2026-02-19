import { Module } from '@nestjs/common';
import { ReportingTools } from './reporting.tools.js';

@Module({
  providers: [ReportingTools],
})
export class ReportingToolsModule {}
