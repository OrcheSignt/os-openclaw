import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosRequestConfig, AxiosError } from 'axios';
import * as jwt from 'jsonwebtoken';

export interface GatewayRequestOptions {
  timeout?: number;
  params?: Record<string, any>;
}

export interface GatewayError {
  service: string;
  path: string;
  status: number;
  message: string;
}

/** Minimum JWT_SECRET length we accept. Below this, HS256 brute force is
 *  realistic. Aligns with OWASP guidance for HMAC secrets. */
const MIN_JWT_SECRET_LENGTH = 32;

@Injectable()
export class GatewayClientService {
  private readonly logger = new Logger(GatewayClientService.name);
  private readonly baseUrl: string;
  private readonly jwtSecret: string;
  private readonly agentUserId: string;
  private readonly agentUserEmail: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'OS_API_GATEWAY_URL',
      'http://os-api-gateway-app/api/v1',
    );

    // Fail closed at module init if JWT_SECRET is missing or too short.
    // Previously this silently defaulted to '' which produced trivially
    // forgeable tokens (security review finding C5).
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret || secret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `GatewayClientService: JWT_SECRET must be set and at least ` +
          `${MIN_JWT_SECRET_LENGTH} characters long. ` +
          `Refusing to sign service-to-service tokens with a weak key.`,
      );
    }
    this.jwtSecret = secret;

    this.agentUserId = this.configService.get<string>('AGENT_USER_ID', '');
    this.agentUserEmail = this.configService.get<string>(
      'AGENT_USER_EMAIL',
      'openclaw-agent@orchesight.internal',
    );
  }

  private generateToken(): string {
    return jwt.sign(
      { sub: this.agentUserId, email: this.agentUserEmail },
      this.jwtSecret,
      { expiresIn: '1h' },
    );
  }

  async request<T>(
    service: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    data?: any,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}/${service}${path}`;

    const config: AxiosRequestConfig = {
      method,
      url,
      data,
      params: options?.params,
      timeout: options?.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.generateToken()}`,
        'X-User-Id': this.agentUserId,
        'X-User-Email': this.agentUserEmail,
      },
    };

    this.logger.debug(`${method} ${url}`);

    try {
      const response = await firstValueFrom(this.httpService.request<T>(config));
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const gwError: GatewayError = {
        service,
        path,
        status: axiosError.response?.status || 0,
        message:
          (axiosError.response?.data as any)?.message ||
          axiosError.message ||
          'Unknown gateway error',
      };
      this.logger.error(
        `Gateway error: ${gwError.service}${gwError.path} -> ${gwError.status} ${gwError.message}`,
      );
      throw new Error(
        `Gateway call failed (${gwError.service}${gwError.path}): ${gwError.status} ${gwError.message}`,
      );
    }
  }

  async get<T>(
    service: string,
    path: string,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.request<T>(service, 'GET', path, undefined, options);
  }

  async post<T>(
    service: string,
    path: string,
    data?: any,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.request<T>(service, 'POST', path, data, options);
  }

  async put<T>(
    service: string,
    path: string,
    data?: any,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.request<T>(service, 'PUT', path, data, options);
  }

  async patch<T>(
    service: string,
    path: string,
    data?: any,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.request<T>(service, 'PATCH', path, data, options);
  }

  // ---------------------------------------------------------------------------
  // v2.0 foundation endpoints (os-investigation internal API)
  // ---------------------------------------------------------------------------

  /**
   * WS-2: fetch the assembled case context document in one round-trip.
   * Backend contract: GET /internal/case-context/:caseId (WS-1).
   * Callers (CaseContextService) own the org validation — this is transport only.
   */
  async getCaseContext<T = unknown>(caseId: string): Promise<T> {
    return this.get<T>(
      'investigation',
      `/internal/case-context/${encodeURIComponent(caseId)}`,
    );
  }

  /**
   * WS-3: persist a validated agent plan to the `agent_plans` collection.
   * POST /internal/agent-plans. Plans are case data: org- and agent-scoped.
   * `organizationId` is the REQUEST org resolved by the caller via
   * requireOrganizationId (deploy pin in static mode, verified authContext
   * org in dynamic mode) — never agent state and never an LLM parameter.
   */
  async createAgentPlan<T = unknown>(
    plan: Record<string, unknown>,
    organizationId: string,
    agentId: string,
  ): Promise<T> {
    return this.post<T>('investigation', '/internal/agent-plans', {
      ...plan,
      organizationId,
      agentId,
    });
  }

  /**
   * WS-3: append a status transition (draft -> approved -> executing ->
   * done | aborted). PATCH /internal/agent-plans/:planId/status.
   */
  async updateAgentPlanStatus<T = unknown>(
    planId: string,
    status: string,
    by: string,
  ): Promise<T> {
    return this.patch<T>(
      'investigation',
      `/internal/agent-plans/${encodeURIComponent(planId)}/status`,
      { status, by },
    );
  }

  /** WS-3: fetch a persisted plan. GET /internal/agent-plans/:planId. */
  async getAgentPlan<T = unknown>(planId: string): Promise<T> {
    return this.get<T>(
      'investigation',
      `/internal/agent-plans/${encodeURIComponent(planId)}`,
    );
  }

  async checkHealth(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/health`;
      const config: AxiosRequestConfig = {
        method: 'GET',
        url,
        timeout: 5000,
      };
      await firstValueFrom(this.httpService.request(config));
      return true;
    } catch {
      return false;
    }
  }
}
