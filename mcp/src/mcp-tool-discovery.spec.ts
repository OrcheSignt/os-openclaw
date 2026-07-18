import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { McpRegistryDiscoveryService } from '@rekog/mcp-nest';
import { AppModule } from './app.module.js';

/**
 * Regression guard for the silent tool-discovery failure: @rekog/mcp-nest only
 * discovers @Tool providers reachable from the module that imports forRoot,
 * UNLESS each feature module registers them via McpModule.forFeature(...). If a
 * tool module forgets forFeature (or its server name drifts from forRoot's),
 * the server still boots and the handshake succeeds but advertises zero tools —
 * every agent run then dies with "no callable tools". This test boots the real
 * AppModule and asserts the tools are actually registered.
 */
describe('MCP tool discovery (AppModule)', () => {
  let app: INestApplication;
  let toolNames: string[];

  beforeAll(async () => {
    // GatewayClientService refuses a JWT_SECRET < 32 chars; AgentIdentityService
    // needs openclaw.json (repo root, one level up from cwd during jest).
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ?? 'test-jwt-secret-at-least-32-characters-long';
    // Per-agent transport tokens are required at boot (fail-closed). Dynamic
    // org mode (no OPENCLAW_AGENT_ORG_*), so org binding comes from authContext.
    for (const a of [
      'EDISCOVERY',
      'PRIVACY',
      'CYBER',
      'COMPLIANCE',
      'RECOMMENDATIONS',
    ]) {
      process.env[`OPENCLAW_MCP_TOKEN_${a}`] =
        process.env[`OPENCLAW_MCP_TOKEN_${a}`] ?? `test-token-${a.toLowerCase()}`;
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = app.get(McpRegistryDiscoveryService);
    const mcpModuleId = app.get<string>('MCP_MODULE_ID');
    toolNames = discovery
      .getTools(mcpModuleId)
      .map((t) => t.metadata.name)
      .sort();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('discovers every tool family (23 tools)', () => {
    expect(toolNames.length).toBe(23);
  });

  it('registers representative tools from each family incl. the planner runtime', () => {
    for (const name of [
      'search_evidence', // evidence
      'log_audit', // management
      'analyze_text', // ml
      'generate_report', // reporting
      'get_pipeline_status', // pipeline
      'get_legal_references', // recommendations
      'submit_plan', // planner
      'compose_answer', // planner
    ]) {
      expect(toolNames).toContain(name);
    }
  });
});
