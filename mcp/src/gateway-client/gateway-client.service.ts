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
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', '');
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
        `Gateway error: ${gwError.service}${gwError.path} → ${gwError.status} ${gwError.message}`,
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

  async patch<T>(
    service: string,
    path: string,
    data?: any,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.request<T>(service, 'PATCH', path, data, options);
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
