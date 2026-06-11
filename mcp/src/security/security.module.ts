import { Global, Module } from '@nestjs/common';
import { AgentIdentityService } from './agent-identity.service.js';
import { CaseContextService } from './case-context.service.js';
import { McpAuthGuard } from './mcp-auth.guard.js';

/**
 * Provides the McpAuthGuard and AgentIdentityService globally so the guard
 * (registered on McpModule.forRoot via the `guards` option) and tool
 * handlers (which call assertCallerCanInvoke) can both resolve them.
 * CaseContextService (WS-2) is exported alongside so case-scoped tool
 * handlers can call requireCaseContext(). Its GatewayClientService
 * dependency resolves through the @Global() GatewayClientModule.
 */
@Global()
@Module({
  providers: [AgentIdentityService, CaseContextService, McpAuthGuard],
  exports: [AgentIdentityService, CaseContextService, McpAuthGuard],
})
export class SecurityModule {}
