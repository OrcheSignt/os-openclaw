import { Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';
import {
  assertAgentMayCall,
  requireAgent,
  requireOrganizationId,
  type McpToolHttpRequest,
} from '../../security/agent-context.js';
import { authContextParam } from '../shared/auth-context-param.js';

@Injectable()
export class RecommendationsTools {
  private readonly logger = new Logger(RecommendationsTools.name);

  constructor(private readonly gateway: GatewayClientService) {}

  @Tool({
    name: 'save_case_recommendation',
    description:
      'Save a case recommendation (case_summary, legal_challenges, or relevant_law). ' +
      'Creates or updates the recommendation for the given case and type.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      type: z
        .enum(['case_summary', 'legal_challenges', 'relevant_law'])
        .describe('Recommendation type'),
      content: z
        .string()
        .describe('Markdown content for display'),
      structured: z
        .record(z.string(), z.any())
        .optional()
        .describe('Structured JSON data following the schema for this type'),
      jurisdiction: z
        .object({
          country: z.string(),
          state: z.string().optional(),
        })
        .optional()
        .describe('Jurisdiction at time of generation'),
      evidenceItemIds: z
        .array(z.string())
        .optional()
        .describe('Evidence item IDs referenced in this recommendation'),
      authContext: authContextParam,
    }),
  })
  async saveCaseRecommendation(
    params: {
      caseId: string;
      type: string;
      content: string;
      structured?: Record<string, any>;
      jurisdiction?: { country: string; state?: string };
      evidenceItemIds?: string[];
      authContext?: string;
    },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'save_case_recommendation');
    const organizationId = requireOrganizationId(req, agent, params.authContext);

    try {
      const result = await this.gateway.put<any>(
        'investigation',
        `/case-recommendations/${params.caseId}/${params.type}`,
        {
          organizationId,
          content: params.content,
          structured: params.structured,
          jurisdiction: params.jurisdiction,
          generatedBy: 'openclaw-recommendations',
          evidenceItemIds: params.evidenceItemIds,
        },
        { timeout: 30000 },
      );

      const version = result?.version || 1;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${params.type} recommendation for case ${params.caseId} (v${version}).`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error saving recommendation: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'get_legal_references',
    description:
      'Look up curated legal references by jurisdiction and case type. ' +
      'Returns applicable laws, statutes, and their relevance to investigation work.',
    parameters: z.object({
      jurisdiction: z
        .string()
        .describe('Jurisdiction code (e.g. IL, US, UK)'),
      case_type: z
        .string()
        .optional()
        .describe('Filter by case type (criminal, civil, cyber, fraud, compliance, internal)'),
      authContext: authContextParam,
    }),
  })
  async getLegalReferences(
    params: {
      jurisdiction: string;
      case_type?: string;
      authContext?: string;
    },
    context: Context,
    req?: McpToolHttpRequest,
  ) {
    const agent = requireAgent(req);
    assertAgentMayCall(agent, 'get_legal_references');
    requireOrganizationId(req, agent, params.authContext);

    try {
      const queryParams = new URLSearchParams({
        jurisdiction: params.jurisdiction,
      });
      if (params.case_type) {
        queryParams.set('caseType', params.case_type);
      }

      const refs = await this.gateway.get<any[]>(
        'investigation',
        `/legal-references?${queryParams.toString()}`,
        { timeout: 15000 },
      );

      if (!refs?.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No legal references found for jurisdiction "${params.jurisdiction}"${params.case_type ? ` and case type "${params.case_type}"` : ''}.`,
            },
          ],
        };
      }

      const formatted = refs.map((ref: any) => {
        let text = `### ${ref.name}`;
        if (ref.nameLocal) text += ` (${ref.nameLocal})`;
        text += `\n**Citation:** ${ref.citation}`;
        text += `\n**Category:** ${ref.category}`;
        text += `\n**Applies to:** ${ref.caseTypes?.join(', ')}`;
        text += `\n**Description:** ${ref.description}`;
        if (ref.relevance) text += `\n**Relevance:** ${ref.relevance}`;
        if (ref.keySections?.length) text += `\n**Key sections:** ${ref.keySections.join('; ')}`;
        return text;
      }).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error fetching legal references: ${error.message}`,
          },
        ],
      };
    }
  }
}
