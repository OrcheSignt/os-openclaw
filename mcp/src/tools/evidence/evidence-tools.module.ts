import { Module } from '@nestjs/common';
import { EvidenceTools } from './evidence.tools.js';

@Module({
  providers: [EvidenceTools],
})
export class EvidenceToolsModule {}
