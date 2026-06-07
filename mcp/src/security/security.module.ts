import { Global, Module } from '@nestjs/common';
import { AgentIdentityService } from './agent-identity.service.js';
import { McpAuthGuard } from './mcp-auth.guard.js';

/**
 * Provides the McpAuthGuard and AgentIdentityService globally so the guard
 * (registered on McpModule.forRoot via the `guards` option) and tool
 * handlers (which call assertCallerCanInvoke) can both resolve them.
 */
@Global()
@Module({
  providers: [AgentIdentityService, McpAuthGuard],
  exports: [AgentIdentityService, McpAuthGuard],
})
export class SecurityModule {}
