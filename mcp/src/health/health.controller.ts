import { Controller, Get } from '@nestjs/common';
import { GatewayClientService } from '../gateway-client/gateway-client.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly gateway: GatewayClientService) {}

  @Get()
  async check() {
    const gatewayReachable = await this.gateway.checkHealth();

    return {
      status: gatewayReachable ? 'ok' : 'degraded',
      gateway: gatewayReachable ? 'reachable' : 'unreachable',
      timestamp: new Date().toISOString(),
    };
  }
}
