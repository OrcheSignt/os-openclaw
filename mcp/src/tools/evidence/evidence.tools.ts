import { Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

@Injectable()
export class EvidenceTools {
  private readonly logger = new Logger(EvidenceTools.name);

  constructor(private readonly gateway: GatewayClientService) {}

  @Tool({
    name: 'search_evidence',
    description:
      'Search evidence items in a case using full-text, keyword, or hybrid search. ' +
      'Returns matching items with metadata, content preview, and total count. ' +
      'Use filters to narrow by type, source, date range, tags, or any field.',
    parameters: z.object({
      caseId: z.string().describe('The case ID to search within'),
      query: z.string().optional().describe('Search query text'),
      filters: z
        .array(
          z.object({
            field: z.string().describe('Field name (e.g. type, source, tags)'),
            value: z.any().describe('Value to filter by'),
          }),
        )
        .optional()
        .describe('Filters to narrow results'),
      size: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of results to return (max 50)'),
      sort: z
        .enum(['relevance', 'date_asc', 'date_desc'])
        .default('relevance')
        .describe('Sort order'),
      searchMode: z
        .enum(['keyword', 'semantic', 'hybrid'])
        .default('hybrid')
        .describe('Search mode'),
    }),
  })
  async searchEvidence(
    params: {
      caseId: string;
      query?: string;
      filters?: Array<{ field: string; value: any }>;
      size: number;
      sort: string;
      searchMode: string;
    },
    context: Context,
  ) {
    const size = Math.min(params.size || 10, 50);

    const filters: any[] = [
      { field: 'caseId', operator: 'term', value: params.caseId },
    ];

    if (params.filters?.length) {
      for (const f of params.filters) {
        filters.push({ field: f.field, operator: 'match', value: f.value });
      }
    }

    const sort =
      params.sort === 'date_asc'
        ? [{ field: 'timestamp', order: 'asc' }]
        : params.sort === 'date_desc'
          ? [{ field: 'timestamp', order: 'desc' }]
          : undefined;

    const request = {
      query: params.query,
      filters,
      searchMode: params.searchMode || 'hybrid',
      sort,
      pagination: { strategy: 'offset', page: 1, size },
    };

    const result = await this.gateway.post<any>(
      'investigation',
      '/search',
      request,
    );

    if (!result.hits?.items?.length) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No results found for "${params.query || 'all'}" (searched ${result.hits?.total || 0} total items).`,
          },
        ],
      };
    }

    let output = `Found ${result.hits.total} results for "${params.query || 'all'}". Showing top ${result.hits.items.length}:\n\n`;
    output += this.formatItems(result.hits.items);

    return { content: [{ type: 'text' as const, text: output }] };
  }

  @Tool({
    name: 'tag_items',
    description:
      'Apply a tag to specific evidence items by their IDs. ' +
      'Tags are used for classification (e.g. "eDiscovery/Privileged", "Privacy/PII-High").',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      organizationId: z.string().describe('The organization ID'),
      tagName: z.string().describe('Tag name (e.g. "eDiscovery/Privileged")'),
      tagColor: z
        .string()
        .optional()
        .describe('Tag color hex (e.g. "#FF0000")'),
      itemIds: z
        .array(z.string())
        .min(1)
        .max(500)
        .describe('Item IDs to tag'),
    }),
  })
  async tagItems(
    params: {
      caseId: string;
      organizationId: string;
      tagName: string;
      tagColor?: string;
      itemIds: string[];
    },
    context: Context,
  ) {
    const result = await this.gateway.post<any>('investigation', '/tags/apply', {
      caseId: params.caseId,
      organizationId: params.organizationId,
      tagName: params.tagName,
      tagColor: params.tagColor || '#3B82F6',
      itemIds: params.itemIds,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Tagged ${params.itemIds.length} item(s) as "${params.tagName}". ${result.modified || params.itemIds.length} items updated.`,
        },
      ],
    };
  }

  @Tool({
    name: 'bulk_tag',
    description:
      'Tag all items matching a search query. More efficient than search + tag for large batches. ' +
      'Uses server-side search-and-tag to handle pagination automatically.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      organizationId: z.string().describe('The organization ID'),
      searchTerm: z.string().describe('Search query to match items'),
      searchMethod: z
        .enum(['keyword', 'semantic', 'hybrid'])
        .default('hybrid')
        .describe('Search method'),
      tagName: z.string().describe('Tag name to apply'),
    }),
  })
  async bulkTag(
    params: {
      caseId: string;
      organizationId: string;
      searchTerm: string;
      searchMethod: string;
      tagName: string;
    },
    context: Context,
  ) {
    const result = await this.gateway.post<any>(
      'investigation',
      '/tags/search-and-tag',
      {
        caseId: params.caseId,
        organizationId: params.organizationId,
        searchTerm: params.searchTerm,
        searchMethod: params.searchMethod,
        tagName: params.tagName,
      },
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Bulk tag complete: "${params.tagName}" applied to ${result.tagged || 'all matching'} items matching "${params.searchTerm}".`,
        },
      ],
    };
  }

  @Tool({
    name: 'get_item_details',
    description:
      'Retrieve full details for specific evidence items by their IDs. ' +
      'Returns complete content, metadata, and communication details. Max 50 items per call.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      itemIds: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Item IDs to retrieve (max 50)'),
    }),
  })
  async getItemDetails(
    params: { caseId: string; itemIds: string[] },
    context: Context,
  ) {
    const itemIds = params.itemIds.slice(0, 50);

    const request = {
      filters: [
        { field: '_id', operator: 'terms', value: itemIds },
        { field: 'caseId', operator: 'term', value: params.caseId },
      ],
      pagination: { strategy: 'offset', page: 1, size: itemIds.length },
    };

    const result = await this.gateway.post<any>(
      'investigation',
      '/search',
      request,
    );

    if (!result.hits?.items?.length) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No items found for the provided IDs.',
          },
        ],
      };
    }

    let output = `Retrieved ${result.hits.items.length} items:\n\n`;
    output += this.formatItems(result.hits.items, true);

    return { content: [{ type: 'text' as const, text: output }] };
  }

  @Tool({
    name: 'aggregate_data',
    description:
      'Run aggregations on evidence data — terms (top values), date_histogram (timeline), or stats (min/max/avg). ' +
      'Useful for case overview, distribution analysis, and trend detection.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      aggType: z
        .enum(['terms', 'date_histogram', 'stats'])
        .describe('Aggregation type'),
      field: z
        .string()
        .describe('Field to aggregate on (e.g. "type", "source", "timestamp")'),
      interval: z
        .string()
        .optional()
        .describe('Interval for date_histogram (e.g. "1d", "1M")'),
      size: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Max buckets for terms aggregation'),
    }),
  })
  async aggregateData(
    params: {
      caseId: string;
      aggType: string;
      field: string;
      interval?: string;
      size: number;
    },
    context: Context,
  ) {
    const agg: any = {
      name: 'result',
      type: params.aggType,
      field: params.field,
      size: Math.min(params.size || 10, 50),
    };
    if (params.aggType === 'date_histogram') {
      agg.interval = params.interval || '1d';
    }

    const request = {
      filters: [
        { field: 'caseId', operator: 'term', value: params.caseId },
      ],
      aggregations: [agg],
      pagination: { strategy: 'offset', page: 1, size: 0 },
    };

    const result = await this.gateway.post<any>(
      'investigation',
      '/search',
      request,
    );

    const aggResult = result.aggregations?.result;
    if (!aggResult) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No aggregation results for ${params.aggType} on field "${params.field}".`,
          },
        ],
      };
    }

    let output: string;

    if (params.aggType === 'stats') {
      output =
        `**Stats for "${params.field}":**\n` +
        `  Count: ${aggResult.count}\n` +
        `  Min: ${aggResult.min}\n` +
        `  Max: ${aggResult.max}\n` +
        `  Avg: ${aggResult.avg?.toFixed(2)}\n` +
        `  Sum: ${aggResult.sum}\n`;
    } else {
      const buckets = aggResult.buckets || [];
      if (!buckets.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No data found for ${params.aggType} on field "${params.field}".`,
            },
          ],
        };
      }

      const label =
        params.aggType === 'date_histogram' ? 'Timeline' : 'Top values';
      output = `**${label} for "${params.field}"** (${result.hits?.total || 0} total items):\n\n`;
      for (const bucket of buckets) {
        const key =
          bucket.key_as_string ||
          (params.aggType === 'date_histogram'
            ? new Date(bucket.key).toLocaleDateString()
            : bucket.key);
        output += `  ${key}: ${bucket.doc_count}\n`;
      }
    }

    return { content: [{ type: 'text' as const, text: output }] };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private formatItems(
    items: Array<{ id: string; data: any; score?: number }>,
    fullContent = false,
  ): string {
    return items
      .map((item, i) => {
        const d = item.data || {};
        const comm = d.communication || {};
        const content = d.content || {};

        const from = this.extractParticipant(comm.from);
        const to = this.extractParticipant(comm.to);
        const subject = content.subject || d.document?.title || '';
        const text =
          d.semanticText ||
          d.bestTextContent ||
          content.body ||
          content.plainText ||
          content.text ||
          '';
        const truncatedText = fullContent
          ? text.substring(0, 1000)
          : text.substring(0, 300);

        let line = `[${i + 1}] ID: ${item.id}\n`;
        line += `    Type: ${d.type || 'unknown'} | Date: ${d.date || d.timestamp || 'N/A'}\n`;
        if (from) line += `    From: ${from}\n`;
        if (to) line += `    To: ${to}\n`;
        if (subject) line += `    Subject: ${subject}\n`;
        if (d.source) line += `    Source: ${d.source}\n`;
        if (truncatedText) {
          line += `    Content: ${truncatedText}${text.length > truncatedText.length ? '...' : ''}\n`;
        }
        return line;
      })
      .join('\n');
  }

  private extractParticipant(field: any): string {
    if (!field) return '';
    if (Array.isArray(field)) {
      return field
        .map(
          (p: any) => p.bestDisplayName || p.name || p.identifier || '',
        )
        .filter(Boolean)
        .join(', ');
    }
    if (typeof field === 'object') {
      return field.bestDisplayName || field.name || field.identifier || '';
    }
    return String(field);
  }
}
