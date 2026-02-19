import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GatewayClientService } from './gateway-client.service.js';

@Global()
@Module({
  imports: [HttpModule],
  providers: [GatewayClientService],
  exports: [GatewayClientService],
})
export class GatewayClientModule {}
