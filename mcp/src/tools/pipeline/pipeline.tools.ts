import { Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

@Injectable()
export class PipelineTools {
  private readonly logger = new Logger(PipelineTools.name);

  constructor(private readonly gateway: GatewayClientService) {}

  @Tool({
    name: 'get_pipeline_status',
    description:
      'Check the status of a data processing pipeline. ' +
      'Returns progress, stage, error count, and completion estimate.',
    parameters: z.object({
      pipelineId: z.string().describe('Pipeline/job ID to check'),
    }),
  })
  async getPipelineStatus(
    params: { pipelineId: string },
    context: Context,
  ) {
    try {
      const result = await this.gateway.get<any>(
        'process',
        `/pipelines/${params.pipelineId}/status`,
      );

      let output = `**Pipeline ${params.pipelineId}:**\n`;
      output += `  Status: ${result.status || 'unknown'}\n`;
      if (result.progress !== undefined)
        output += `  Progress: ${result.progress}%\n`;
      if (result.stage) output += `  Stage: ${result.stage}\n`;
      if (result.processedItems !== undefined)
        output += `  Processed: ${result.processedItems}/${result.totalItems || '?'}\n`;
      if (result.errorCount !== undefined)
        output += `  Errors: ${result.errorCount}\n`;
      if (result.estimatedCompletion)
        output += `  ETA: ${result.estimatedCompletion}\n`;

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error checking pipeline status: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'trigger_enrichment',
    description:
      'Trigger data enrichment or post-processing on evidence items. ' +
      'Starts an async pipeline job and returns the job ID for status tracking.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      enrichmentType: z
        .enum([
          'ocr',
          'translation',
          'entity_extraction',
          'deduplication',
          'full',
        ])
        .describe('Type of enrichment to run'),
      itemIds: z
        .array(z.string())
        .optional()
        .describe('Specific item IDs (omit for all items in case)'),
      options: z
        .record(z.string(), z.any())
        .optional()
        .describe('Enrichment-specific options'),
    }),
  })
  async triggerEnrichment(
    params: {
      caseId: string;
      enrichmentType: string;
      itemIds?: string[];
      options?: Record<string, any>;
    },
    context: Context,
  ) {
    try {
      const result = await this.gateway.post<any>(
        'process',
        '/pipelines/start',
        {
          caseId: params.caseId,
          type: params.enrichmentType,
          itemIds: params.itemIds,
          options: params.options,
        },
        { timeout: 30000 },
      );

      const jobId = result.jobId || result.pipelineId || result._id || result.id;

      return {
        content: [
          {
            type: 'text' as const,
            text: `Enrichment pipeline started: ${params.enrichmentType} for case ${params.caseId}. Job ID: ${jobId || 'created'}. Use get_pipeline_status to track progress.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error triggering enrichment: ${error.message}`,
          },
        ],
      };
    }
  }
}
