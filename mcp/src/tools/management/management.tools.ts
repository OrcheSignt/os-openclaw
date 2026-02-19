import { Injectable, Logger } from '@nestjs/common';
import { Tool, Context } from '@rekog/mcp-nest';
import { z } from 'zod';
import { GatewayClientService } from '../../gateway-client/gateway-client.service.js';

@Injectable()
export class ManagementTools {
  private readonly logger = new Logger(ManagementTools.name);

  constructor(private readonly gateway: GatewayClientService) {}

  @Tool({
    name: 'create_notification',
    description:
      'Send a notification to a user. Use for alerts about critical findings, ' +
      'task assignments, or case updates. Supports priority levels and action URLs.',
    parameters: z.object({
      userId: z.string().describe('Target user ID'),
      title: z.string().max(200).describe('Notification title'),
      message: z.string().max(1000).describe('Notification message body'),
      type: z
        .enum(['info', 'warning', 'error', 'success'])
        .default('info')
        .describe('Notification type'),
      priority: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .default('MEDIUM')
        .describe('Priority level'),
      actionUrl: z
        .string()
        .optional()
        .describe('URL to navigate to when clicked'),
      caseId: z.string().optional().describe('Related case ID'),
    }),
  })
  async createNotification(
    params: {
      userId: string;
      title: string;
      message: string;
      type: string;
      priority: string;
      actionUrl?: string;
      caseId?: string;
    },
    context: Context,
  ) {
    const result = await this.gateway.post<any>(
      'project',
      '/notifications',
      {
        userId: params.userId,
        title: params.title,
        message: params.message,
        type: params.type,
        priority: params.priority,
        actionUrl: params.actionUrl,
        caseId: params.caseId,
        source: 'openclaw-agent',
      },
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Notification sent to user ${params.userId}: "${params.title}" (priority: ${params.priority}). ID: ${result._id || result.id || 'created'}`,
        },
      ],
    };
  }

  @Tool({
    name: 'create_task',
    description:
      'Create a task in the project management system. Use for assigning review work, ' +
      'follow-up actions, or compliance checks to team members.',
    parameters: z.object({
      title: z.string().max(300).describe('Task title'),
      organizationId: z.string().describe('Organization ID'),
      caseId: z.string().optional().describe('Related case ID'),
      assignedToList: z
        .array(z.string())
        .optional()
        .describe('User IDs to assign'),
      priority: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .default('MEDIUM')
        .describe('Task priority'),
      dueDate: z
        .string()
        .optional()
        .describe('Due date (ISO 8601 format)'),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe('Task description'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags for categorization'),
    }),
  })
  async createTask(
    params: {
      title: string;
      organizationId: string;
      caseId?: string;
      assignedToList?: string[];
      priority: string;
      dueDate?: string;
      description?: string;
      tags?: string[];
    },
    context: Context,
  ) {
    const result = await this.gateway.post<any>('project', '/tasks', {
      title: params.title,
      organizationId: params.organizationId,
      caseId: params.caseId,
      assignedToList: params.assignedToList,
      priority: params.priority,
      dueDate: params.dueDate,
      description: params.description,
      tags: params.tags,
      source: 'openclaw-agent',
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task created: "${params.title}" (priority: ${params.priority}). ID: ${result._id || result.id || 'created'}${params.assignedToList?.length ? `, assigned to ${params.assignedToList.length} user(s)` : ''}`,
        },
      ],
    };
  }

  @Tool({
    name: 'update_task',
    description:
      'Update an existing task — change status, progress, or add a comment. ' +
      'Use to track work progress on review tasks.',
    parameters: z.object({
      taskId: z.string().describe('Task ID to update'),
      status: z
        .enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'])
        .optional()
        .describe('New task status'),
      progress: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Progress percentage (0-100)'),
      comment: z
        .string()
        .max(2000)
        .optional()
        .describe('Comment to add to the task'),
    }),
  })
  async updateTask(
    params: {
      taskId: string;
      status?: string;
      progress?: number;
      comment?: string;
    },
    context: Context,
  ) {
    const updates: string[] = [];

    if (params.status || params.progress !== undefined) {
      const patchData: any = {};
      if (params.status) patchData.status = params.status;
      if (params.progress !== undefined) patchData.progress = params.progress;

      await this.gateway.patch<any>(
        'project',
        `/tasks/${params.taskId}`,
        patchData,
      );
      if (params.status) updates.push(`status → ${params.status}`);
      if (params.progress !== undefined)
        updates.push(`progress → ${params.progress}%`);
    }

    if (params.comment) {
      await this.gateway.post<any>(
        'project',
        `/tasks/${params.taskId}/comments`,
        {
          text: params.comment,
          source: 'openclaw-agent',
        },
      );
      updates.push('comment added');
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${params.taskId} updated: ${updates.join(', ') || 'no changes'}.`,
        },
      ],
    };
  }

  @Tool({
    name: 'update_case_progress',
    description:
      'Update the overall progress percentage for a case. ' +
      'Use to reflect how much of the evidence has been reviewed/processed.',
    parameters: z.object({
      caseId: z.string().describe('Case ID'),
      progress: z
        .number()
        .min(0)
        .max(100)
        .describe('Progress percentage (0-100)'),
    }),
  })
  async updateCaseProgress(
    params: { caseId: string; progress: number },
    context: Context,
  ) {
    await this.gateway.patch<any>(
      'project',
      `/cases/${params.caseId}/progress`,
      { progress: params.progress },
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Case ${params.caseId} progress updated to ${params.progress}%.`,
        },
      ],
    };
  }

  @Tool({
    name: 'log_audit',
    description:
      'Create an audit log entry for compliance tracking. ' +
      'Records agent actions, evidence access, and regulatory events.',
    parameters: z.object({
      action: z
        .string()
        .describe('Action performed (e.g. "evidence_classified", "pii_detected")'),
      resourceType: z
        .string()
        .describe('Resource type (e.g. "evidence", "case", "task")'),
      resourceId: z.string().optional().describe('ID of the affected resource'),
      severity: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .default('LOW')
        .describe('Severity level'),
      category: z
        .string()
        .optional()
        .describe('Category (e.g. "ediscovery", "privacy", "cyber")'),
      compliance: z
        .object({
          gdprRelevant: z.boolean().optional(),
          ccpaRelevant: z.boolean().optional(),
          retentionRequired: z.boolean().optional(),
        })
        .optional()
        .describe('Compliance metadata'),
      details: z
        .string()
        .max(2000)
        .optional()
        .describe('Additional details'),
    }),
  })
  async logAudit(
    params: {
      action: string;
      resourceType: string;
      resourceId?: string;
      severity: string;
      category?: string;
      compliance?: {
        gdprRelevant?: boolean;
        ccpaRelevant?: boolean;
        retentionRequired?: boolean;
      };
      details?: string;
    },
    context: Context,
  ) {
    await this.gateway.post<any>('project', '/audit-logs', {
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      severity: params.severity,
      category: params.category,
      compliance: params.compliance,
      details: params.details,
      source: 'openclaw-agent',
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Audit log created: ${params.action} on ${params.resourceType}${params.resourceId ? ` (${params.resourceId})` : ''} [${params.severity}]`,
        },
      ],
    };
  }
}
