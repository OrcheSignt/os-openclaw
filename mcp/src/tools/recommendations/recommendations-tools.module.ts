import { Module } from '@nestjs/common';
import { RecommendationsTools } from './recommendations.tools.js';

@Module({
  providers: [RecommendationsTools],
})
export class RecommendationsToolsModule {}
