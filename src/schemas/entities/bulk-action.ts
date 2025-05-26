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

export const bulkActionTypeSchema = z.enum(['bulk_update']); // We can expand this later for more action types

export const entityTypeSchema = z.enum(['contact']); // we can expand this later for more entity types

// Configuration schema
export const bulkActionConfigurationSchema = z
  .object({
    deduplicate: z.boolean().default(false),
    onConflict: z.enum(['skip', 'error', 'update']).default('skip'),
  })
  .passthrough(); // Allow additional properties

// Full bulk action schema
export const bulkActionSchema = baseEntitySchema.extend({
  id: uuidSchema,
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
  id: uuidSchema,
  accountId: z.string().min(1, 'Account ID is required'),
  entityType: entityTypeSchema,
  actionType: bulkActionTypeSchema,
  status: bulkActionStatusSchema.default('queued'),
  totalEntities: z.number().int().min(0).default(0),
  processedEntities: z.number().int().min(0).default(0),
  scheduledAt: timestampSchema.optional(),
  configuration: bulkActionConfigurationSchema.default({}),
});

export const idParamSchema = z.object({
  id: z.string().uuid('Invalid action ID format'),
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
  configuration: bulkActionConfigurationSchema.default({
    deduplicate: false, // Default to false if not provided
    onConflict: 'skip', // Default conflict resolution strategy
  }),
});

// Export inferred types
export type BulkActionSchema = z.infer<typeof bulkActionSchema>;
export type BulkActionCreateSchema = z.infer<typeof bulkActionCreateSchema>;
export type BulkActionQuerySchema = z.infer<typeof bulkActionQuerySchema>;
export type CreateBulkActionRequestSchema = z.infer<typeof createBulkActionRequestSchema>;
