import { Router } from 'express';
import { bulkActionController } from '../controllers';
import { authenticationMiddleware, validationMiddleware } from '../middlewares';
import {
  minioFileUpload,
  validateMinioUpload,
  cleanupFailedUpload,
} from '../middlewares/minioUploadMiddleware';
import { idParamSchema, bulkActionQuerySchema, createBulkActionRequestSchema } from '../../schemas';

const router = Router();

/**
 * POST /bulk-actions
 * Create a new bulk action with MinIO CSV file upload
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Rate limiting - 10k rows/minute limit (only for POST)
 * 3. MinIO file upload - Stream directly to MinIO with validation
 * 4. Upload validation - Validate MinIO upload success
 * 5. Request validation - Validate JSON body
 * 6. Cleanup middleware - Handle failed uploads
 * 7. Controller - Handle business logic
 * 8. Error handler - Handle MinIO/Multer specific errors
 */
router.post(
  '/',
  authenticationMiddleware,
  minioFileUpload,
  validateMinioUpload,
  validationMiddleware(createBulkActionRequestSchema, 'body'),
  cleanupFailedUpload,
  bulkActionController.createBulkAction
);

/**
 * GET /bulk-actions
 * List bulk actions with pagination and filtering
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Query validation - Validate query parameters
 * 3. Controller - Handle business logic
 */
router.get(
  '/',
  authenticationMiddleware,
  validationMiddleware(bulkActionQuerySchema, 'query'),
  bulkActionController.getBulkActions
);

/**
 * GET /bulk-actions/{id}
 * Get detailed information about a specific bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:id',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionController.getBulkActionById
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
  bulkActionController.getBulkActionStats
);

/**
 * PUT /bulk-actions/{id}/cancel
 * Cancel a pending or processing bulk action
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.put(
  '/:id/cancel',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionController.cancelBulkAction
);

/**
 * GET /bulk-actions/{id}/download
 * Get download URL for the original uploaded file
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Param validation - Validate action ID format
 * 3. Controller - Handle business logic
 */
router.get(
  '/:id/download',
  authenticationMiddleware,
  validationMiddleware(idParamSchema, 'params'),
  bulkActionController.getFileDownloadUrl
);

export default router;
