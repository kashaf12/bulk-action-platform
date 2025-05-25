import { Router } from 'express';
import { healthController } from '../controllers';

const router = Router();

/**
 * GET /health
 * Basic health check endpoint
 *
 * This endpoint should be lightweight and fast
 * Used by load balancers and monitoring systems
 */
router.get('/', healthController.healthCheck);

/**
 * GET /health/detailed
 * Detailed health check with dependency status
 *
 * This endpoint checks all system dependencies
 * May take longer to respond due to dependency checks
 */
router.get('/detailed', healthController.detailedHealthCheck);

/**
 * GET /health/ready
 * Readiness probe for Kubernetes
 *
 * Indicates if the service is ready to accept traffic
 */
router.get('/ready', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Service is ready',
    data: {
      status: 'ready',
      timestamp: new Date().toISOString(),
    },
    traceId: (req as any).traceId,
  });
});

/**
 * GET /health/live
 * Liveness probe for Kubernetes
 *
 * Indicates if the service is alive and functioning
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Service is alive',
    data: {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
    traceId: (req as any).traceId,
  });
});

export default router;
