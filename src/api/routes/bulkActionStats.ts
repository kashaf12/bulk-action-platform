/**
 * Routes for bulk action statistics endpoints
 * Implements RESTful API routes with proper middleware chains
 */

import { Router } from 'express';
import { bulkActionStatController } from '../controllers';
import { authenticationMiddleware, validationMiddleware } from '../middlewares';
import { idParamSchema } from '../../schemas';
import { rateLimitMiddleware } from '../middlewares/rateLimitMiddleware';

const router = Router();

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
  rateLimitMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionStatController.getBulkActionStats
);

export default router;
