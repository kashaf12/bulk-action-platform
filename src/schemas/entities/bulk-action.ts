/**
 * Bulk Action validation schemas
 */

import { z } from 'zod';
import { baseEntitySchema, uuidSchema, timestampSchema } from '../base';

// Enum schemas
export const bulkActionStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);

export const bulkActionTypeSchema = z.enum(['bulk_update', 'bulk_delete', 'bulk_create']);

export const entityTypeSchema = z.enum(['contact', 'company', 'lead', 'opportunity', 'task']);

// Configuration schema
export const bulkActionConfigurationSchema = z
  .object({
    deduplicate: z.boolean().default(false),
  })
  .passthrough(); // Allow additional properties

// Full bulk action schema
export const bulkActionSchema = baseEntitySchema.extend({
  actionId: uuidSchema,
  accountId: z.string().min(1, 'Account ID is required'),
  entityType: entityTypeSchema,
  actionType: bulkActionTypeSchema,
  status: bulkActionStatusSchema.default('queued'),
  totalEntities: z.number().int().min(0).default(0),
  processedEntities: z.number().int().min(0).default(0),
  scheduledAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  configuration: bulkActionConfigurationSchema.default({}),
  errorMessage: z.string().optional(),
});

// Bulk action creation schema
export const bulkActionCreateSchema = z.object({
  actionId: uuidSchema,
  accountId: z.string().min(1, 'Account ID is required'),
  entityType: entityTypeSchema,
  actionType: bulkActionTypeSchema,
  status: bulkActionStatusSchema.default('queued'),
  totalEntities: z.number().int().min(0).default(0),
  processedEntities: z.number().int().min(0).default(0),
  scheduledAt: timestampSchema.optional(),
  configuration: bulkActionConfigurationSchema.default({}),
});

export const actionIdParamSchema = z.object({
  actionId: z.string().uuid('Invalid action ID format'),
});

// Query parameters schema
export const bulkActionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

// API request schemas
export const createBulkActionRequestSchema = z.object({
  entityType: entityTypeSchema,
  actionType: bulkActionTypeSchema,
  scheduledAt: timestampSchema.optional(),
  configuration: bulkActionConfigurationSchema.default({}),
});

// Export inferred types
export type BulkActionSchema = z.infer<typeof bulkActionSchema>;
export type BulkActionCreateSchema = z.infer<typeof bulkActionCreateSchema>;
export type BulkActionQuerySchema = z.infer<typeof bulkActionQuerySchema>;
export type CreateBulkActionRequestSchema = z.infer<typeof createBulkActionRequestSchema>;
