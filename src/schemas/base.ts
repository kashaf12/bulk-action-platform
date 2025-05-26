/**
 * Base validation schemas using Zod
 * Provides reusable validation patterns
 */

import { z } from 'zod';

// UUID validation
export const uuidSchema = z.string().uuid('Invalid UUID format');

// Pagination schemas
export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit cannot exceed 100')
    .default(10),
});

// Common field schemas
export const emailSchema = z.string().email('Invalid email format').toLowerCase().trim();

export const nameSchema = z
  .string()
  .min(1, 'Name cannot be empty')
  .max(255, 'Name too long')
  .trim()
  .optional();

export const timestampSchema = z.coerce.date();

// Base entity schema
export const baseEntitySchema = z.object({
  id: uuidSchema.optional(),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
});

// Query parameter helpers
export const stringToArraySchema = z
  .string()
  .transform(val => val.split(',').map(s => s.trim()))
  .or(z.array(z.string()));

export const booleanSchema = z
  .union([z.boolean(), z.string().transform(val => val === 'true')])
  .default(false);
