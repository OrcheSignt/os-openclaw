import { Injectable, Logger } from '@nestjs/common';
import { Tool, Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

@Injectable()
export class ReportingTools {
  private readonly logger = new Logger(ReportingTools.name);

  constructor(private readonly gateway: GatewayClientService) {}

  @Tool({
    name: 'generate_report',
    description:
      'Generate an investigation report. Returns a download URL or report ID. ' +
      'Available types: evidence-statistics, pois-report, timeline-report, communications-report.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      reportType: z
        .enum([
          'evidence-statistics',
          'pois-report',
          'timeline-report',
          'communications-report',
        ])
        .describe('Type of report to generate'),
      filters: z
        .record(z.any())
        .optional()
        .describe('Optional filters to narrow the report scope'),
    }),
  })
  async generateReport(
    params: {
      caseId: string;
      reportType: string;
      filters?: Record<string, any>;
    },
    context: Context,
  ) {
    try {
      const result = await this.gateway.post<any>(
        'reporting',
        `/investigation-reports/${params.reportType}`,
        {
          caseId: params.caseId,
          filters: params.filters,
        },
        { timeout: 120000 },
      );

      const reportId = result._id || result.id || result.reportId;
      const downloadUrl = result.downloadUrl || result.url;

      let text = `Report "${params.reportType}" generated for case ${params.caseId}.`;
      if (reportId) text += ` Report ID: ${reportId}.`;
      if (downloadUrl) text += ` Download: ${downloadUrl}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error generating report: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'export_items',
    description:
      'Export evidence items to a file (CSV, PDF, or XLSX). ' +
      'Returns the storage path of the exported file.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      itemIds: z
        .array(z.string())
        .optional()
        .describe('Specific item IDs to export (omit for all)'),
      format: z
        .enum(['csv', 'pdf', 'xlsx'])
        .default('csv')
        .describe('Export format'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Fields to include in export'),
    }),
  })
  async exportItems(
    params: {
      caseId: string;
      itemIds?: string[];
      format: string;
      fields?: string[];
    },
    context: Context,
  ) {
    try {
      const result = await this.gateway.post<any>(
        'reporting',
        '/investigation-reports/export-items',
        {
          caseId: params.caseId,
          itemIds: params.itemIds,
          format: params.format,
          fields: params.fields,
        },
        { timeout: 120000 },
      );

      const storagePath = result.path || result.storagePath || result.url;

      return {
        content: [
          {
            type: 'text' as const,
            text: `Export complete (${params.format}): ${storagePath || 'file created'}. ${params.itemIds?.length ? `${params.itemIds.length} items` : 'All items'} exported.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error exporting items: ${error.message}`,
          },
        ],
      };
    }
  }
}
