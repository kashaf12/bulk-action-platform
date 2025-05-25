import { Router, Request, Response } from 'express';
import bulkActionsRoutes from './bulkActions';
import bulkActionStatsRoutes from './bulkActionStats';
import healthRoutes from './health';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * API version and welcome endpoint
 * GET /
 */
router.get('/', (req: Request, res: Response) => {
  const traceId = (req as any).traceId;

  logger.info('API root endpoint accessed', { traceId });

  res.json({
    success: true,
    message: 'Bulk Action Platform API',
    data: {
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      endpoints: {
        bulkActions: '/bulk-actions',
        bulkActionStats: '/bulk-actions/{actionId}/stats',
        health: '/health',
        documentation: '/docs', // Future implementation
      },
    },
    traceId,
  });
});

/**
 * Mount route modules
 */
router.use('/bulk-actions', bulkActionsRoutes);
router.use('/bulk-actions', bulkActionStatsRoutes);
router.use('/health', healthRoutes);

/**
 * API documentation endpoint (future implementation)
 */
router.get('/docs', (req: Request, res: Response) => {
  const traceId = (req as any).traceId;

  res.json({
    success: true,
    message: 'API Documentation',
    data: {
      message: 'API documentation will be available here',
      swaggerUrl: '/swagger.json', // Future implementation
      postmanCollection: '/postman.json', // Future implementation
      endpoints: {
        bulkActions: {
          create: 'POST /bulk-actions',
          list: 'GET /bulk-actions',
          get: 'GET /bulk-actions/{actionId}',
          stats: 'GET /bulk-actions/{actionId}/stats',
          cancel: 'PUT /bulk-actions/{actionId}/cancel',
        },
        bulkActionStats: {
          get: 'GET /bulk-actions/{actionId}/stats',
          initialize: 'POST /bulk-actions/{actionId}/stats/initialize',
          increment: 'PUT /bulk-actions/{actionId}/stats/increment',
          validate: 'GET /bulk-actions/{actionId}/stats/validate',
          delete: 'DELETE /bulk-actions/{actionId}/stats',
          exists: 'GET /bulk-actions/{actionId}/stats/exists',
        },
        health: {
          basic: 'GET /health',
          detailed: 'GET /health/detailed',
          ready: 'GET /health/ready',
          live: 'GET /health/live',
        },
      },
    },
    traceId,
  });
});

export default router;
