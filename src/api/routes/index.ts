import { Router, Request, Response } from 'express';
import bulkActionsRoutes from './bulkActions';
import bulkActionStatsRoutes from './bulkActionStats';
import healthRoutes from './health';
import { logger } from '../../utils/logger';
import config from '../../config/app';
import { rateLimitMiddleware } from '../middlewares/rateLimitMiddleware';

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
      version: config.getNpmPackageVersion(),
      environment: config.getEnvironment(),
      timestamp: new Date().toISOString(),
      endpoints: {
        bulkActions: '/bulk-actions',
        bulkActionStats: '/bulk-actions/{id}/stats',
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
      endpoints: {
        bulkActions: {
          create: 'POST /bulk-actions',
          list: 'GET /bulk-actions',
          get: 'GET /bulk-actions/{id}',
        },
        bulkActionStats: {
          get: 'GET /bulk-actions/{id}/stats',
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
