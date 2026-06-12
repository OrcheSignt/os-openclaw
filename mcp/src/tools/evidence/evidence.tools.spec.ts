import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { Context } from '@rekog/mcp-nest';
import { EvidenceTools } from './evidence.tools.js';
import { AUTH_CONTEXT_SCOPE } from '../../security/auth-context.service.js';
import type { AgentIdentity } from '../../security/agent-identity.service.js';
import type { McpToolHttpRequest } from '../../security/agent-context.js';
import type { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

const SECRET = 'unit-test-jwt-secret-at-least-32-characters!!';
const PINNED_ORG = '6650f0a1b2c3d4e5f6a7b8c9';
const TOKEN_ORG = '777777777777777777777777';

const ALLOW = new Set(['tag_items', 'search_evidence']);
const STATIC_AGENT: AgentIdentity = {
  id: 'ediscovery',
  organizationId: PINNED_ORG,
  allow: ALLOW,
};
const DYNAMIC_AGENT: AgentIdentity = {
  id: 'ediscovery',
  organizationId: null,
  allow: ALLOW,
};

function mint(org: string): string {
  return jwt.sign(
    { sub: 'user-7', org, scope: AUTH_CONTEXT_SCOPE, jti: 'jti-77' },
    SECRET,
    { algorithm: 'HS256', expiresIn: 600 },
  );
}

const TAG_PARAMS = {
  caseId: 'case-1',
  tagName: 'eDiscovery/Relevant',
  itemIds: ['item-1', 'item-2'],
};

describe('EvidenceTools org binding (representative tool: tag_items)', () => {
  const ctx = {} as Context;
  let prevSecret: string | undefined;
  let gateway: { post: jest.Mock };
  let tools: EvidenceTools;

  beforeAll(() => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  beforeEach(() => {
    gateway = { post: jest.fn().mockResolvedValue({ modified: 2 }) };
    tools = new EvidenceTools(gateway as unknown as GatewayClientService);
  });

  function reqFor(agent: AgentIdentity): McpToolHttpRequest {
    return { openClawAgent: agent, headers: {} };
  }

  it('DYNAMIC happy path: the org sent to the backend is the token org', async () => {
    const req = reqFor(DYNAMIC_AGENT);
    const result = await tools.tagItems(
      { ...TAG_PARAMS, authContext: mint(TOKEN_ORG) },
      ctx,
      req,
    );

    expect(gateway.post).toHaveBeenCalledWith(
      'investigation',
      '/tags/apply',
      expect.objectContaining({
        caseId: 'case-1',
        organizationId: TOKEN_ORG,
      }),
    );
    expect(result.content[0].text).toContain('Tagged 2 item(s)');
    // verified context attached for downstream consumers (audit actor)
    expect(req.authContext).toMatchObject({
      userId: 'user-7',
      organizationId: TOKEN_ORG,
    });
  });

  it('DYNAMIC mode rejects a call without authContext (fail-closed)', async () => {
    await expect(
      tools.tagItems(TAG_PARAMS, ctx, reqFor(DYNAMIC_AGENT)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.post).not.toHaveBeenCalled();
  });

  it('STATIC mode without a token keeps using the pinned org (unchanged)', async () => {
    await tools.tagItems(TAG_PARAMS, ctx, reqFor(STATIC_AGENT));
    expect(gateway.post).toHaveBeenCalledWith(
      'investigation',
      '/tags/apply',
      expect.objectContaining({ organizationId: PINNED_ORG }),
    );
  });

  it('STATIC mode rejects a token whose org disagrees with the pin', async () => {
    await expect(
      tools.tagItems(
        { ...TAG_PARAMS, authContext: mint(TOKEN_ORG) },
        ctx,
        reqFor(STATIC_AGENT),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.post).not.toHaveBeenCalled();
  });
});
