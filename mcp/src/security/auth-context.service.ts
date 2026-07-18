import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

/**
 * AuthContext — the signed user-context token that binds an agent action to
 * the ACTIVE ORG OF THE USER WHO STARTED the chat/procedure.
 *
 * Contract (shared with os-investigation, which mints these tokens):
 * a compact HS256 JWT signed with the shared env JWT_SECRET, claims:
 *
 *   {
 *     sub:    <userId>,
 *     org:    <organizationId string>,
 *     caseId?: <string>,
 *     scope:  'openclaw-agent',
 *     iat, exp (TTL <= 3600s), jti
 *   }
 *
 * The agent passes it VERBATIM as the `authContext` string parameter on
 * every MCP tool call. The LLM can only RELAY the token — it cannot forge
 * or alter the org (the signature covers it), so tenancy stays enforced in
 * code, never LLM-discretionary (platform doc §9.4).
 */

/** Required scope claim. Tokens minted for any other audience are rejected. */
export const AUTH_CONTEXT_SCOPE = 'openclaw-agent';

/** Maximum token lifetime the contract allows (exp - iat), in seconds. */
export const AUTH_CONTEXT_MAX_TTL_SECONDS = 3600;

/** The verified, trusted view of an authContext token. */
export interface VerifiedAuthContext {
  userId: string;
  organizationId: string;
  caseId?: string;
  jti: string;
}

interface AuthContextClaims {
  sub?: unknown;
  org?: unknown;
  caseId?: unknown;
  scope?: unknown;
  iat?: unknown;
  exp?: unknown;
  jti?: unknown;
}

function forbid(reason: string): never {
  throw new ForbiddenException(`authContext rejected: ${reason}`);
}

/**
 * Verifies an authContext token and returns its trusted claims.
 *
 * Checks, fail-closed (every failure is a ForbiddenException with a
 * distinct, clear reason):
 *   - HS256 signature against the shared JWT_SECRET,
 *   - expiry (no clock-skew allowance beyond jsonwebtoken defaults),
 *   - scope === 'openclaw-agent',
 *   - required claims present (sub, org, jti) and TTL within the
 *     contract's 3600s cap.
 */
export function verifyAuthContext(token: string): VerifiedAuthContext {
  if (!token || typeof token !== 'string') {
    forbid('token is missing or not a string');
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Server misconfiguration — but still fail closed rather than skip
    // verification. GatewayClientService enforces the secret at boot, so
    // this only triggers in unusual test/runtime setups.
    forbid('server has no JWT_SECRET configured to verify it');
  }

  let claims: AuthContextClaims;
  try {
    claims = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    }) as AuthContextClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      forbid(
        'token is expired — ask the operator to restart the session to ' +
          'obtain a fresh authContext',
      );
    }
    forbid(`token is invalid (${(err as Error).message})`);
  }

  if (claims.scope !== AUTH_CONTEXT_SCOPE) {
    forbid(
      `token has wrong scope "${String(claims.scope)}" — expected ` +
        `"${AUTH_CONTEXT_SCOPE}"`,
    );
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    forbid('token is invalid (missing sub claim)');
  }
  if (typeof claims.org !== 'string' || claims.org.length === 0) {
    forbid('token is invalid (missing org claim)');
  }
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
    forbid('token is invalid (missing jti claim)');
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    forbid('token is invalid (missing exp/iat claims)');
  }
  if (claims.exp - claims.iat > AUTH_CONTEXT_MAX_TTL_SECONDS) {
    forbid(
      `token TTL exceeds the contract maximum of ` +
        `${AUTH_CONTEXT_MAX_TTL_SECONDS}s`,
    );
  }

  return {
    userId: claims.sub,
    organizationId: claims.org,
    caseId: typeof claims.caseId === 'string' ? claims.caseId : undefined,
    jti: claims.jti,
  };
}
