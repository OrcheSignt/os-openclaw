import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AgentIdentity,
  AgentIdentityService,
} from './agent-identity.service.js';

/**
 * Request augmentation: McpAuthGuard attaches the resolved agent identity
 * onto the Express request so downstream code (tool handlers) can read it
 * without re-parsing the bearer token.
 */
export type RequestWithAgent = Request & {
  openClawAgent?: AgentIdentity;
};

/**
 * Bearer-token guard for the MCP HTTP transport.
 *
 * Closes the security gap where the `/mcp` endpoint had no authentication
 * at all (C2) and where the per-agent `allow` array in openclaw.json was
 * never consulted (C1). Resolves the token to an agent identity (and its
 * pinned organizationId) via AgentIdentityService, attaches it to the
 * request, and rejects the request when:
 *   - the Authorization header is missing or malformed,
 *   - the token does not match any configured agent,
 *   - (for tools/call) the agent's allow list does not include the tool.
 *
 * Note: per-tool allowlist enforcement happens here only when we can
 * cheaply parse the JSON-RPC body. Tool handlers also do a defense-in-depth
 * check via assertCallerCanInvoke() so STDIO/raw transports remain safe.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  private readonly logger = new Logger(McpAuthGuard.name);

  constructor(private readonly agentIdentity: AgentIdentityService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithAgent>();

    const header =
      req.headers?.authorization || (req.headers?.Authorization as string);
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing Authorization header');
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      throw new UnauthorizedException(
        'Authorization header must be "Bearer <token>"',
      );
    }
    const token = match[1].trim();
    const agent = this.agentIdentity.resolveToken(token);
    if (!agent) {
      this.logger.warn('Rejected MCP request with unknown bearer token');
      throw new UnauthorizedException('Invalid MCP bearer token');
    }

    req.openClawAgent = agent;

    // Best-effort allowlist enforcement at the guard layer. The body has
    // already been parsed by Nest (the streamable-http controller declares
    // @Body()), so we can introspect tools/call requests cheaply.
    const body: any = (req as any).body;
    if (body && body.method === 'tools/call') {
      const toolName: string | undefined = body?.params?.name;
      if (toolName && !this.agentIdentity.isToolAllowed(agent, toolName)) {
        this.logger.warn(
          `Agent "${agent.id}" denied access to tool "${toolName}"`,
        );
        // 401 keeps the response shape uniform; per-tool 403s leak which
        // tools exist to an unauthenticated probe.
        throw new UnauthorizedException(
          `Agent "${agent.id}" is not permitted to call tool "${toolName}"`,
        );
      }
    }

    return true;
  }
}
