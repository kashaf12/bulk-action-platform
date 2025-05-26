/**
 * Routes for bulk action statistics endpoints
 * Implements RESTful API routes with proper middleware chains
 */

import { Router } from 'express';
import { bulkActionStatController } from '../controllers';
import { authenticationMiddleware, validationMiddleware } from '../middlewares';
import { idParamSchema } from '../../schemas';
import { z } from 'zod';

const router = Router();

// Validation schemas for request bodies
const initializeStatsSchema = z.object({
  totalRecords: z.number().int().min(0, 'Total records must be non-negative'),
});

const incrementStatsSchema = z
  .object({
    successful: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    skipped: z.number().int().min(0).optional(),
    duplicate: z.number().int().min(0).optional(),
  })
  .refine(
    data => {
      // At least one increment must be provided and positive
      return Object.values(data).some(value => value !== undefined && value > 0);
    },
    {
      message: 'At least one positive increment must be provided',
    }
  );

/**
 * GET /bulk-actions/{id}/stats
 * Get statistics for a specific bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:id/stats',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionStatController.getBulkActionStats
);

/**
 * POST /bulk-actions/{id}/stats/initialize
 * Initialize empty statistics for a bulk action (internal use)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Body validation - Validate initialization data
 * 4. Controller - Handle business logic
 */
router.post(
  '/:id/stats/initialize',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  validationMiddleware(initializeStatsSchema, 'body'),
  bulkActionStatController.initializeBulkActionStats
);

/**
 * PUT /bulk-actions/{id}/stats/increment
 * Increment statistics counters (for workers)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Body validation - Validate increment data
 * 4. Controller - Handle business logic
 */
router.put(
  '/:id/stats/increment',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  validationMiddleware(incrementStatsSchema, 'body'),
  bulkActionStatController.incrementBulkActionStats
);

/**
 * GET /bulk-actions/{id}/stats/validate
 * Validate statistics consistency
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:id/stats/validate',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionStatController.validateBulkActionStats
);

/**
 * DELETE /bulk-actions/{id}/stats
 * Delete statistics for a bulk action (cleanup)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.delete(
  '/:id/stats',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionStatController.deleteBulkActionStats
);

/**
 * GET /bulk-actions/{id}/stats/exists
 * Check if statistics exist for a bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:id/stats/exists',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionStatController.checkBulkActionStatsExist
);

export default router;
