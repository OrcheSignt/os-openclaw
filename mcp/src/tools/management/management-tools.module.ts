import { Module } from '@nestjs/common';
import { ManagementTools } from './management.tools.js';

@Module({
  providers: [ManagementTools],
})
export class ManagementToolsModule {}
