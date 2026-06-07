import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';

/**
 * Agent identity resolved from a bearer token.
 *
 * Tools should consume `organizationId` from this object (populated on the
 * request by McpAuthGuard) rather than from LLM-supplied parameters.
 */
export interface AgentIdentity {
  id: string;
  organizationId: string;
  allow: ReadonlySet<string> | null;
}

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
 * Fails closed at boot if either mapping is missing for any configured
 * agent -- the MCP server will not start.
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
      const organizationId = orgMap.get(agent.id);

      if (!token) {
        missing.push(`token for "${agent.id}"`);
        continue;
      }
      if (!organizationId) {
        missing.push(`organizationId for "${agent.id}"`);
        continue;
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
          `Set OPENCLAW_MCP_TOKENS_JSON / OPENCLAW_AGENT_ORG_JSON or the per-agent ` +
          `OPENCLAW_MCP_TOKEN_<AGENT> / OPENCLAW_AGENT_ORG_<AGENT> env vars.`,
      );
    }

    this.logger.log(
      `Loaded ${this.agents.size} agent identities: ${[...this.agents.keys()].join(', ')}`,
    );
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
