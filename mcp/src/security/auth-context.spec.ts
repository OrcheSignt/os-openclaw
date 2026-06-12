import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import {
  AUTH_CONTEXT_SCOPE,
  verifyAuthContext,
} from './auth-context.service.js';

const SECRET = 'unit-test-jwt-secret-at-least-32-characters!!';
const OTHER_SECRET = 'a-different-secret-also-32-characters-long!!';
const ORG = '6650f0a1b2c3d4e5f6a7b8c9';

const nowSec = () => Math.floor(Date.now() / 1000);

interface MintOverrides {
  [claim: string]: unknown;
}

/** Mints a contract-conformant token; overrides poke holes in it. */
function mint(overrides: MintOverrides = {}, secret = SECRET): string {
  const payload: Record<string, unknown> = {
    sub: 'user-1',
    org: ORG,
    scope: AUTH_CONTEXT_SCOPE,
    jti: 'jti-1',
    iat: nowSec(),
    exp: nowSec() + 600,
    ...overrides,
  };
  // Strip claims explicitly nulled by a test.
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) delete payload[k];
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

describe('verifyAuthContext', () => {
  let prevSecret: string | undefined;

  beforeAll(() => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  it('accepts a valid token and returns the trusted claims', () => {
    const token = mint({ caseId: 'case-9' });
    expect(verifyAuthContext(token)).toEqual({
      userId: 'user-1',
      organizationId: ORG,
      caseId: 'case-9',
      jti: 'jti-1',
    });
  });

  it('returns undefined caseId when the optional claim is absent', () => {
    expect(verifyAuthContext(mint()).caseId).toBeUndefined();
  });

  it('rejects an expired token with a distinct "expired" reason', () => {
    const token = mint({ iat: nowSec() - 100, exp: nowSec() - 50 });
    expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    expect(() => verifyAuthContext(token)).toThrow(/expired/);
  });

  it('rejects a token signed with the wrong secret as invalid', () => {
    const token = mint({}, OTHER_SECRET);
    expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    expect(() => verifyAuthContext(token)).toThrow(/invalid/);
  });

  it('rejects a structurally broken token as invalid', () => {
    expect(() => verifyAuthContext('not-a-jwt')).toThrow(ForbiddenException);
    expect(() => verifyAuthContext('not-a-jwt')).toThrow(/invalid/);
  });

  it('rejects a token with the wrong scope', () => {
    const token = mint({ scope: 'some-other-service' });
    expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    expect(() => verifyAuthContext(token)).toThrow(/wrong scope/);
  });

  it('rejects a token whose TTL exceeds the 3600s contract cap', () => {
    const token = mint({ exp: nowSec() + 7200 });
    expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    expect(() => verifyAuthContext(token)).toThrow(/TTL/);
  });

  it.each(['sub', 'org', 'jti'])(
    'rejects a token missing the required %s claim',
    (claim) => {
      const token = mint({ [claim]: undefined });
      expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    },
  );

  it('fails closed when the server has no JWT_SECRET', () => {
    const token = mint();
    delete process.env.JWT_SECRET;
    try {
      expect(() => verifyAuthContext(token)).toThrow(ForbiddenException);
    } finally {
      process.env.JWT_SECRET = SECRET;
    }
  });

  it('fails closed on an empty token', () => {
    expect(() => verifyAuthContext('')).toThrow(ForbiddenException);
  });
});
