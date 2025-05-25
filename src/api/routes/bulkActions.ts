import { Router } from 'express';
import { bulkActionController } from '../controllers';
import {
  authenticationMiddleware,
  validationMiddleware,
  csvValidationMiddleware,
  createBulkActionRateLimit,
} from '../middlewares';
import { secureFileUpload, csvSecurityValidation } from '../middlewares/fileSecurityMiddleware';
import {
  actionIdParamSchema,
  bulkActionCreateSchema,
  bulkActionQuerySchema,
  createBulkActionRequestSchema,
} from '../../schemas';

const router = Router();

// Required CSV headers for different entity types
const CONTACT_REQUIRED_HEADERS = ['email'];

/**
 * POST /bulk-actions
 * Create a new bulk action with CSV file upload
 *
 * Middleware chain:
 * 1. Authentication - Validate account ID
 * 2. Rate limiting - 10k rows/minute limit (only for POST)
 * 3. File upload - Secure file handling with Multer
 * 4. CSV security validation - Check for malicious content
 * 5. CSV validation - Validate headers and format
 * 6. Request validation - Validate JSON body
 * 7. Controller - Handle business logic
 */
router.post(
  '/',
  authenticationMiddleware,
  secureFileUpload.single('file'),
  csvValidationMiddleware,
  validationMiddleware(createBulkActionRequestSchema, 'body'),
  bulkActionController.createBulkAction
);

/**
 * GET /bulk-actions
 * List bulk actions with pagination and filtering
 *
 * Middleware chain:
 * 1. Tracing - Add correlation ID
 * 2. Authentication - Validate account ID
 * 3. Query validation - Validate query parameters
 * 4. Controller - Handle business logic
 */
router.get(
  '/',
  authenticationMiddleware,
  validationMiddleware(bulkActionQuerySchema, 'query'),
  bulkActionController.getBulkActions
);

/**
 * GET /bulk-actions/{actionId}
 * Get detailed information about a specific bulk action
 *
 * Middleware chain:
 * 1. Tracing - Add correlation ID
 * 2. Authentication - Validate account ID
 * 3. Param validation - Validate action ID format
 * 4. Controller - Handle business logic
 */
router.get(
  '/:actionId',
  authenticationMiddleware,
  validationMiddleware(actionIdParamSchema, 'params'),
  bulkActionController.getBulkActionById
);

export default router;
