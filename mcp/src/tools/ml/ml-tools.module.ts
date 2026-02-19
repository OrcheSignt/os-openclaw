import { Module } from '@nestjs/common';
import { MlTools } from './ml.tools.js';

@Module({
  providers: [MlTools],
})
export class MlToolsModule {}
