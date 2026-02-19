import { Module } from '@nestjs/common';
import { PipelineTools } from './pipeline.tools.js';

@Module({
  providers: [PipelineTools],
})
export class PipelineToolsModule {}
