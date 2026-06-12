import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import {
  requireOrganizationId,
  resolveOrganizationId,
  type McpToolHttpRequest,
} from './agent-context.js';
import { AUTH_CONTEXT_SCOPE } from './auth-context.service.js';
import type { AgentIdentity } from './agent-identity.service.js';

const SECRET = 'unit-test-jwt-secret-at-least-32-characters!!';
const PINNED_ORG = '6650f0a1b2c3d4e5f6a7b8c9';
const TOKEN_ORG = '777777777777777777777777';

const STATIC_AGENT: AgentIdentity = {
  id: 'ediscovery',
  organizationId: PINNED_ORG,
  allow: null,
};
const DYNAMIC_AGENT: AgentIdentity = {
  id: 'ediscovery',
  organizationId: null,
  allow: null,
};

function mint(org: string, overrides: Record<string, unknown> = {}): string {
  const payload = {
    sub: 'user-7',
    org,
    scope: AUTH_CONTEXT_SCOPE,
    jti: 'jti-77',
    ...overrides,
  };
  // expiresIn and an explicit exp claim are mutually exclusive in jwt.sign.
  const options =
    'exp' in payload
      ? ({ algorithm: 'HS256' } as const)
      : ({ algorithm: 'HS256', expiresIn: 600 } as const);
  return jwt.sign(payload, SECRET, options);
}

describe('requireOrganizationId', () => {
  let prevSecret: string | undefined;
  let req: McpToolHttpRequest;

  beforeAll(() => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  beforeEach(() => {
    req = { headers: {} };
  });

  describe('STATIC mode (deploy-pinned org)', () => {
    it('returns the pinned org when no authContext is supplied', () => {
      expect(requireOrganizationId(req, STATIC_AGENT)).toBe(PINNED_ORG);
      expect(req.authContext).toBeUndefined();
    });

    it('verifies a supplied authContext and attaches it when orgs agree', () => {
      const token = mint(PINNED_ORG);
      expect(requireOrganizationId(req, STATIC_AGENT, token)).toBe(PINNED_ORG);
      expect(req.authContext).toMatchObject({
        userId: 'user-7',
        organizationId: PINNED_ORG,
        jti: 'jti-77',
      });
    });

    it('rejects a token whose org disagrees with the pin (injection signal)', () => {
      const token = mint(TOKEN_ORG);
      expect(() => requireOrganizationId(req, STATIC_AGENT, token)).toThrow(
        ForbiddenException,
      );
      expect(() => requireOrganizationId(req, STATIC_AGENT, token)).toThrow(
        /injection/,
      );
      expect(req.authContext).toBeUndefined();
    });

    it('still rejects an invalid token even though the org is pinned', () => {
      expect(() =>
        requireOrganizationId(req, STATIC_AGENT, 'garbage'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('DYNAMIC mode (org from verified authContext)', () => {
    it('returns the token org and attaches the verified context', () => {
      const token = mint(TOKEN_ORG);
      expect(requireOrganizationId(req, DYNAMIC_AGENT, token)).toBe(TOKEN_ORG);
      expect(req.authContext).toMatchObject({
        userId: 'user-7',
        organizationId: TOKEN_ORG,
      });
    });

    it('fails closed when the authContext is missing', () => {
      expect(() => requireOrganizationId(req, DYNAMIC_AGENT)).toThrow(
        ForbiddenException,
      );
      expect(() => requireOrganizationId(req, DYNAMIC_AGENT)).toThrow(
        /authContext/,
      );
    });

    it('fails closed on an expired token', () => {
      const token = mint(TOKEN_ORG, {
        iat: Math.floor(Date.now() / 1000) - 100,
        exp: Math.floor(Date.now() / 1000) - 50,
      });
      expect(() => requireOrganizationId(req, DYNAMIC_AGENT, token)).toThrow(
        /expired/,
      );
    });

    it('fails closed on a forged signature', () => {
      const forged = jwt.sign(
        {
          sub: 'user-7',
          org: TOKEN_ORG,
          scope: AUTH_CONTEXT_SCOPE,
          jti: 'jti-77',
        },
        'attacker-controlled-secret-32-chars-long!!',
        { expiresIn: 600 },
      );
      expect(() => requireOrganizationId(req, DYNAMIC_AGENT, forged)).toThrow(
        ForbiddenException,
      );
    });
  });
});

describe('resolveOrganizationId (deprecated static-only path)', () => {
  it('keeps returning the pinned org for static agents', () => {
    expect(resolveOrganizationId(STATIC_AGENT)).toBe(PINNED_ORG);
  });

  it('keeps rejecting a disagreeing LLM-supplied org', () => {
    expect(() => resolveOrganizationId(STATIC_AGENT, TOKEN_ORG)).toThrow(
      ForbiddenException,
    );
  });

  it('fails closed for dynamic-mode agents', () => {
    expect(() => resolveOrganizationId(DYNAMIC_AGENT)).toThrow(
      ForbiddenException,
    );
  });
});
