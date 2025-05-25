/**
 * Routes for bulk action statistics endpoints
 * Implements RESTful API routes with proper middleware chains
 */

import { Router } from 'express';
import { bulkActionStatController } from '../controllers';
import { authenticationMiddleware, validationMiddleware } from '../middlewares';
import { actionIdParamSchema } from '../../schemas';
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
 * GET /bulk-actions/{actionId}/stats
 * Get statistics for a specific bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:actionId/stats',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  bulkActionStatController.getBulkActionStats
);

/**
 * POST /bulk-actions/{actionId}/stats/initialize
 * Initialize empty statistics for a bulk action (internal use)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Body validation - Validate initialization data
 * 4. Controller - Handle business logic
 */
router.post(
  '/:actionId/stats/initialize',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  validationMiddleware(initializeStatsSchema, 'body'),
  bulkActionStatController.initializeBulkActionStats
);

/**
 * PUT /bulk-actions/{actionId}/stats/increment
 * Increment statistics counters (for workers)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Body validation - Validate increment data
 * 4. Controller - Handle business logic
 */
router.put(
  '/:actionId/stats/increment',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  validationMiddleware(incrementStatsSchema, 'body'),
  bulkActionStatController.incrementBulkActionStats
);

/**
 * GET /bulk-actions/{actionId}/stats/validate
 * Validate statistics consistency
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:actionId/stats/validate',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  bulkActionStatController.validateBulkActionStats
);

/**
 * DELETE /bulk-actions/{actionId}/stats
 * Delete statistics for a bulk action (cleanup)
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.delete(
  '/:actionId/stats',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  bulkActionStatController.deleteBulkActionStats
);

/**
 * GET /bulk-actions/{actionId}/stats/exists
 * Check if statistics exist for a bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:actionId/stats/exists',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  bulkActionStatController.checkBulkActionStatsExist
);

export default router;
