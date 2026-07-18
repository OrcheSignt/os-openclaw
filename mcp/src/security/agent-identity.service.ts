import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';

/**
 * Agent identity resolved from a bearer token.
 *
 * ORG BINDING MODES (see also agent-context.ts requireOrganizationId):
 *
 *   STATIC  — OPENCLAW_AGENT_ORG_<ID> (or the JSON blob) is set for the
 *             agent: `organizationId` is pinned at deploy time. Tool calls
 *             use the pinned org; an authContext token, if also supplied,
 *             is verified and must agree with the pin (mismatch is treated
 *             as an injection signal). This keeps single-tenant / on-prem
 *             deploys working unchanged.
 *
 *   DYNAMIC — no org env var for the agent: `organizationId` is null at
 *             identity load. EVERY tool call must then carry a valid
 *             `authContext` token (HS256, signed by os-investigation with
 *             the shared JWT_SECRET); the request org is the verified
 *             token org — the active org of the user who started the
 *             chat/procedure. Missing/invalid token fails closed.
 *
 * Tools must never read `organizationId` from LLM-supplied parameters;
 * resolve it via requireOrganizationId(req, agent, authContext).
 */
export interface AgentIdentity {
  id: string;
  /** Pinned org (STATIC mode) or null (DYNAMIC mode — org per request). */
  organizationId: string | null;
  allow: ReadonlySet<string> | null;
}

/** Pinned org ids must be Mongo ObjectIds — anything else (including the
 *  deploy placeholders like REPLACE_WITH_DEV_TENANT_ORG_ID) is treated as
 *  "configured but invalid" and is fatal at boot. */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

interface AgentConfig {
  id: string;
  tools?: { profile?: string; allow?: string[] };
}

interface OpenclawConfig {
  agents?: { list?: AgentConfig[] };
}

/**
 * Loads agent -> bearer-token and agent -> organizationId mappings from
 * environment, plus per-agent tool allowlists from openclaw.json, and
 * exposes lookups used by McpAuthGuard.
 *
 * Token distribution shapes supported (entries merge, per-agent env vars
 * override the JSON blob):
 *   1. OPENCLAW_MCP_TOKENS_JSON='{"ediscovery":"...","privacy":"..."}'
 *   2. OPENCLAW_MCP_TOKEN_EDISCOVERY=..., OPENCLAW_MCP_TOKEN_PRIVACY=... etc.
 *
 * organizationId distribution (per agent, same merge rule):
 *   1. OPENCLAW_AGENT_ORG_JSON='{"ediscovery":"<orgId>",...}'
 *   2. OPENCLAW_AGENT_ORG_EDISCOVERY=<orgId> etc.
 *
 * Fails closed at boot if a token is missing for any configured agent, or
 * if an org value is SET but not a valid ObjectId (e.g. a deploy
 * placeholder) -- the MCP server will not start. An ABSENT org value is
 * not an error: it selects DYNAMIC org binding for that agent (see the
 * AgentIdentity doc above), where every tool call must carry a verified
 * authContext token.
 */
@Injectable()
export class AgentIdentityService implements OnModuleInit {
  private readonly logger = new Logger(AgentIdentityService.name);

  /** token -> agent identity */
  private readonly tokenToAgent = new Map<string, AgentIdentity>();
  /** agent id -> identity (for diagnostics / future use) */
  private readonly agents = new Map<string, AgentIdentity>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const configPath = this.resolveOpenclawConfigPath();
    const agentConfigs = this.loadAgentsFromConfig(configPath);

    if (agentConfigs.length === 0) {
      throw new Error(
        `AgentIdentityService: no agents found in ${configPath}. ` +
          `Refusing to start an MCP server with no identities configured.`,
      );
    }

    const tokenMap = this.loadTokenMap();
    const orgMap = this.loadOrgMap();

    const missing: string[] = [];
    for (const agent of agentConfigs) {
      const token = tokenMap.get(agent.id);
      const organizationId = orgMap.get(agent.id) ?? null;

      if (!token) {
        missing.push(`token for "${agent.id}"`);
        continue;
      }
      // Org binding mode selection:
      //   - absent  -> DYNAMIC (org resolved per request from authContext),
      //   - set but not a valid ObjectId (e.g. a "REPLACE_WITH_..." deploy
      //     placeholder) -> fatal, exactly as before,
      //   - valid ObjectId -> STATIC pin.
      if (organizationId !== null && !OBJECT_ID_RE.test(organizationId)) {
        throw new Error(
          `AgentIdentityService: organizationId configured for "${agent.id}" ` +
            `is not a valid ObjectId ("${organizationId}"). Set a real org id ` +
            `for static pinning, or unset OPENCLAW_AGENT_ORG_* entirely to ` +
            `enable dynamic per-request org binding via authContext.`,
        );
      }
      if (this.tokenToAgent.has(token)) {
        throw new Error(
          `AgentIdentityService: duplicate token configured for "${agent.id}". ` +
            `Each agent must have a unique bearer token.`,
        );
      }

      const allow = agent.tools?.allow;
      const identity: AgentIdentity = {
        id: agent.id,
        organizationId,
        allow: Array.isArray(allow) ? new Set(allow) : null,
      };
      this.tokenToAgent.set(token, identity);
      this.agents.set(agent.id, identity);
    }

    if (missing.length > 0) {
      throw new Error(
        `AgentIdentityService: missing required configuration -- ${missing.join(', ')}. ` +
          `Set OPENCLAW_MCP_TOKENS_JSON or the per-agent ` +
          `OPENCLAW_MCP_TOKEN_<AGENT> env vars.`,
      );
    }

    const summary = [...this.agents.values()]
      .map(
        (a) =>
          `${a.id} (${a.organizationId === null ? 'dynamic org' : 'static org'})`,
      )
      .join(', ');
    this.logger.log(`Loaded ${this.agents.size} agent identities: ${summary}`);
  }

  /** Resolve a bearer token to an agent identity, or null if unknown. */
  resolveToken(token: string): AgentIdentity | null {
    if (!token) return null;
    return this.tokenToAgent.get(token) ?? null;
  }

  /** Whether an agent is permitted to invoke a given tool name. */
  isToolAllowed(agent: AgentIdentity, toolName: string): boolean {
    if (agent.allow === null) return true;
    return agent.allow.has(toolName);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private resolveOpenclawConfigPath(): string {
    const fromEnv = this.configService.get<string>('OPENCLAW_CONFIG_PATH');
    if (fromEnv) {
      return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    }
    const candidates = [
      resolve(process.cwd(), 'openclaw.json'),
      resolve(process.cwd(), '..', 'openclaw.json'),
      resolve(__dirname, '..', '..', '..', 'openclaw.json'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  private loadAgentsFromConfig(configPath: string): AgentConfig[] {
    if (!existsSync(configPath)) {
      throw new Error(
        `AgentIdentityService: openclaw.json not found at ${configPath}. ` +
          `Set OPENCLAW_CONFIG_PATH to point at it.`,
      );
    }
    let parsed: OpenclawConfig;
    try {
      const raw = readFileSync(configPath, 'utf8');
      parsed = JSON.parse(raw) as OpenclawConfig;
    } catch (err) {
      throw new Error(
        `AgentIdentityService: failed to read/parse ${configPath}: ${(err as Error).message}`,
      );
    }
    const list = parsed.agents?.list ?? [];
    return list.filter(
      (a): a is AgentConfig => typeof a?.id === 'string' && a.id.length > 0,
    );
  }

  private loadTokenMap(): Map<string, string> {
    const map = new Map<string, string>();
    const jsonRaw = this.configService.get<string>('OPENCLAW_MCP_TOKENS_JSON');
    if (jsonRaw) {
      try {
        const obj = JSON.parse(jsonRaw) as Record<string, string>;
        for (const [agentId, token] of Object.entries(obj)) {
          if (typeof token === 'string' && token.length > 0) {
            map.set(agentId, token);
          }
        }
      } catch (err) {
        throw new Error(
          `AgentIdentityService: OPENCLAW_MCP_TOKENS_JSON is not valid JSON: ${(err as Error).message}`,
        );
      }
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('OPENCLAW_MCP_TOKEN_')) continue;
      const agentId = key.slice('OPENCLAW_MCP_TOKEN_'.length).toLowerCase();
      if (!agentId || !value) continue;
      map.set(agentId, value);
    }
    return map;
  }

  private loadOrgMap(): Map<string, string> {
    const map = new Map<string, string>();
    const jsonRaw = this.configService.get<string>('OPENCLAW_AGENT_ORG_JSON');
    if (jsonRaw) {
      try {
        const obj = JSON.parse(jsonRaw) as Record<string, string>;
        for (const [agentId, orgId] of Object.entries(obj)) {
          if (typeof orgId === 'string' && orgId.length > 0) {
            map.set(agentId, orgId);
          }
        }
      } catch (err) {
        throw new Error(
          `AgentIdentityService: OPENCLAW_AGENT_ORG_JSON is not valid JSON: ${(err as Error).message}`,
        );
      }
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('OPENCLAW_AGENT_ORG_')) continue;
      const agentId = key.slice('OPENCLAW_AGENT_ORG_'.length).toLowerCase();
      if (!agentId || !value) continue;
      map.set(agentId, value);
    }
    return map;
  }
}
