import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tool, Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

@Injectable()
export class MlTools {
  private readonly logger = new Logger(MlTools.name);
  private readonly tritonDirectUrl: string;

  constructor(
    private readonly gateway: GatewayClientService,
    private readonly configService: ConfigService,
  ) {
    this.tritonDirectUrl = this.configService.get<string>(
      'TRITON_GATEWAY_DIRECT_URL',
      '',
    );
  }

  @Tool({
    name: 'analyze_text',
    description:
      'Run ML analysis on text: NER (entity extraction), sentiment analysis, ' +
      'text classification, translation, or language detection. ' +
      'Text is truncated at 5000 characters.',
    parameters: z.object({
      text: z.string().min(1).describe('Text to analyze (max 5000 chars)'),
      analysisType: z
        .enum(['ner', 'sentiment', 'classify', 'translate', 'detect_language'])
        .describe('Type of analysis'),
      entityTypes: z
        .array(z.string())
        .optional()
        .describe('For NER: entity types to extract (e.g. person, phone, email, ssn)'),
      categories: z
        .array(z.string())
        .optional()
        .describe('For classify: categories to classify into'),
      targetLanguage: z
        .string()
        .optional()
        .describe('For translate: target ISO language code (e.g. "en", "he")'),
    }),
  })
  async analyzeText(
    params: {
      text: string;
      analysisType: string;
      entityTypes?: string[];
      categories?: string[];
      targetLanguage?: string;
    },
    context: Context,
  ) {
    let text = params.text;
    if (text.length > 5000) {
      text = text.substring(0, 5000);
    }

    try {
      const requestBody: any = {
        text,
        analysisType: params.analysisType,
      };

      if (params.analysisType === 'ner' && params.entityTypes) {
        requestBody.entityTypes = params.entityTypes;
      }
      if (params.analysisType === 'classify' && params.categories) {
        requestBody.categories = params.categories;
      }
      if (params.analysisType === 'translate' && params.targetLanguage) {
        requestBody.targetLanguage = params.targetLanguage;
      }

      const result = await this.gateway.post<any>(
        'ml',
        '/analyze/text',
        requestBody,
        { timeout: 60000 },
      );

      const output = this.formatMlResult(params.analysisType, result);
      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ML analysis failed — ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'analyze_image',
    description:
      'Run ML analysis on an image: OCR (text extraction), object detection, or face detection. ' +
      'First fetches the item from investigation to get the file path, then runs analysis.',
    parameters: z.object({
      caseId: z.string().describe('The case ID'),
      itemId: z.string().describe('Evidence item ID containing the image'),
      analysisType: z
        .enum(['ocr', 'detect_objects', 'detect_faces'])
        .describe('Type of image analysis'),
    }),
  })
  async analyzeImage(
    params: {
      caseId: string;
      itemId: string;
      analysisType: string;
    },
    context: Context,
  ) {
    try {
      // 1. Fetch item to get file path
      const searchResult = await this.gateway.post<any>(
        'investigation',
        '/search',
        {
          filters: [
            { field: '_id', operator: 'terms', value: [params.itemId] },
            { field: 'caseId', operator: 'term', value: params.caseId },
          ],
          pagination: { strategy: 'offset', page: 1, size: 1 },
        },
      );

      if (!searchResult.hits?.items?.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Item "${params.itemId}" not found in this case.`,
            },
          ],
        };
      }

      const item = searchResult.hits.items[0].data;
      const filePath = item.paths?.minioPath || item.forensic?.minioPath;

      if (!filePath) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Item "${params.itemId}" does not have a file path.`,
            },
          ],
        };
      }

      // 2. Call ML service
      const result = await this.gateway.post<any>(
        'ml',
        '/analyze/image',
        {
          filePath,
          analysisType: params.analysisType,
        },
        { timeout: 60000 },
      );

      const output = this.formatImageResult(params.analysisType, result);
      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: Image analysis failed — ${error.message}`,
          },
        ],
      };
    }
  }

  // ===========================================================================
  // FORMATTERS (matching tool-executor.ts patterns)
  // ===========================================================================

  private formatMlResult(analysisType: string, result: any): string {
    switch (analysisType) {
      case 'ner':
        return this.formatNerResult(result);
      case 'sentiment':
        return this.formatSentimentResult(result);
      case 'classify':
        return this.formatClassifyResult(result);
      case 'translate':
        return this.formatTranslateResult(result);
      case 'detect_language':
        return this.formatLanguageResult(result);
      default:
        return JSON.stringify(result, null, 2);
    }
  }

  private formatImageResult(analysisType: string, result: any): string {
    switch (analysisType) {
      case 'ocr': {
        const text =
          result?.text ||
          result?.results?.[0]?.text ||
          result?.extracted_text ||
          result?.content;
        if (!text) return 'No text could be extracted from this image.';
        const truncated =
          text.length > 3000 ? text.substring(0, 3000) + '...' : text;
        return `**OCR extracted text:**\n${truncated}`;
      }
      case 'detect_objects': {
        const objects =
          result?.objects ||
          result?.results?.[0]?.objects ||
          result?.detections ||
          [];
        if (!objects.length) return 'No objects detected in the image.';
        const formatted = objects
          .sort(
            (a: any, b: any) =>
              (b.confidence || b.score || 0) - (a.confidence || a.score || 0),
          )
          .map(
            (o: any) =>
              `${o.label || o.class || o.name} (${Math.round((o.confidence || o.score || 0) * 100)}%)`,
          )
          .join(', ');
        return `**Objects detected:** ${formatted}`;
      }
      case 'detect_faces': {
        const faces =
          result?.faces ||
          result?.results?.[0]?.faces ||
          result?.detections ||
          [];
        if (!faces.length) return 'No faces detected in the image.';
        return `**Faces detected:** ${faces.length} face${faces.length > 1 ? 's' : ''} found in the image`;
      }
      default:
        return JSON.stringify(result, null, 2);
    }
  }

  private formatNerResult(result: any): string {
    const entities = result?.entities || result?.results?.[0]?.entities || [];
    if (!entities.length) return 'No named entities found in the text.';

    const grouped: Record<string, Array<{ text: string; score: number }>> = {};
    for (const entity of entities) {
      const type = entity.type || entity.label || 'unknown';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({
        text: entity.text || entity.word || entity.value || '',
        score: entity.score || entity.confidence || 0,
      });
    }

    let output = '**Named entities found:**\n';
    for (const [type, items] of Object.entries(grouped)) {
      const formatted = items
        .sort((a, b) => b.score - a.score)
        .map((e) => `${e.text} (${Math.round(e.score * 100)}%)`)
        .join(', ');
      output += `**${type}:** ${formatted}\n`;
    }
    return output;
  }

  private formatSentimentResult(result: any): string {
    const sentiment =
      result?.sentiment || result?.results?.[0]?.sentiment || result?.label;
    const score =
      result?.score || result?.results?.[0]?.score || result?.confidence;
    if (!sentiment) return 'Could not determine sentiment.';
    return `**Sentiment:** ${sentiment} (${score ? `${(score * 100).toFixed(1)}%` : 'N/A'})`;
  }

  private formatClassifyResult(result: any): string {
    const scores =
      result?.scores || result?.results?.[0]?.scores || result?.labels;
    if (!scores || (Array.isArray(scores) && !scores.length)) {
      return 'Could not classify the text.';
    }

    let entries: Array<{ label: string; score: number }>;
    if (Array.isArray(scores)) {
      entries = scores.map((s: any) => ({
        label: s.label || s.category || '',
        score: s.score || s.confidence || 0,
      }));
    } else {
      entries = Object.entries(scores).map(([label, score]) => ({
        label,
        score: score as number,
      }));
    }

    entries.sort((a, b) => b.score - a.score);

    let output = '**Classification results:**\n';
    for (const entry of entries) {
      output += `  ${entry.label}: ${(entry.score * 100).toFixed(1)}%\n`;
    }
    return output;
  }

  private formatTranslateResult(result: any): string {
    const translated =
      result?.translated_text ||
      result?.translation ||
      result?.results?.[0]?.translated_text ||
      result?.text;
    if (!translated) return 'Translation failed — no result returned.';
    const sourceLang =
      result?.detected_language || result?.source_language || 'auto';
    return `**Translation (${sourceLang} → target):**\n${translated}`;
  }

  private formatLanguageResult(result: any): string {
    const language =
      result?.language || result?.detected_language || result?.lang;
    if (!language) return 'Could not detect language.';
    const confidence = result?.confidence || result?.score;
    let output = `**Detected language:** ${language}`;
    if (confidence) {
      output += ` (${(confidence * 100).toFixed(1)}% confidence)`;
    }
    return output;
  }
}
