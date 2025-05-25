/**
 * Bulk Action Statistics validation schemas
 */

import { z } from 'zod';
import { baseEntitySchema, uuidSchema } from '../base';

// Full bulk action stat schema
export const bulkActionStatSchema = baseEntitySchema.extend({
  actionId: uuidSchema,
  totalRecords: z.number().int().min(0).default(0),
  successfulRecords: z.number().int().min(0).default(0),
  failedRecords: z.number().int().min(0).default(0),
  skippedRecords: z.number().int().min(0).default(0),
  duplicateRecords: z.number().int().min(0).default(0),
});

// Bulk action stat creation schema
export const bulkActionStatCreateSchema = z.object({
  actionId: uuidSchema,
  totalRecords: z.number().int().min(0).default(0),
  successfulRecords: z.number().int().min(0).default(0),
  failedRecords: z.number().int().min(0).default(0),
  skippedRecords: z.number().int().min(0).default(0),
  duplicateRecords: z.number().int().min(0).default(0),
});

// Bulk action stat update schema (all fields optional)
export const bulkActionStatUpdateSchema = z.object({
  totalRecords: z.number().int().min(0).optional(),
  successfulRecords: z.number().int().min(0).optional(),
  failedRecords: z.number().int().min(0).optional(),
  skippedRecords: z.number().int().min(0).optional(),
  duplicateRecords: z.number().int().min(0).optional(),
});

// Validation for stats consistency
export const bulkActionStatConsistencySchema = bulkActionStatSchema.refine(
  data => {
    const processed = data.successfulRecords + data.failedRecords + data.skippedRecords;
    // Allow for duplicate records to be counted separately
    return processed <= data.totalRecords;
  },
  {
    message: 'Sum of processed records cannot exceed total records',
    path: ['totalRecords'],
  }
);

// Export inferred types
export type BulkActionStatSchema = z.infer<typeof bulkActionStatSchema>;
export type BulkActionStatCreateSchema = z.infer<typeof bulkActionStatCreateSchema>;
export type BulkActionStatUpdateSchema = z.infer<typeof bulkActionStatUpdateSchema>;
