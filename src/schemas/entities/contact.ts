/**
 * Contact entity validation schemas
 */

import { z } from 'zod';
import { baseEntitySchema, emailSchema, nameSchema } from '../base';

// Contact status enum
export const contactStatusSchema = z.enum(['active', 'inactive', 'pending']).default('active');

// Full contact schema
export const contactSchema = baseEntitySchema.extend({
  name: nameSchema,
  email: emailSchema,
  age: z.number().int().min(1).max(150).optional(),
});

// Contact creation schema (stricter requirements)
export const contactCreateSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  age: z.number().int().min(1).max(150).optional(),
});

// Contact update schema (all fields optional except constraints)
export const contactUpdateSchema = z.object({
  name: nameSchema,
  email: emailSchema.optional(),
  age: z.number().int().min(1).max(150).optional(),
});

// Contact query parameters
export const contactQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
});

// Export inferred types
export type ContactSchema = z.infer<typeof contactSchema>;
export type ContactCreateSchema = z.infer<typeof contactCreateSchema>;
export type ContactUpdateSchema = z.infer<typeof contactUpdateSchema>;
export type ContactQuerySchema = z.infer<typeof contactQuerySchema>;
