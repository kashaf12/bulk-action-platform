import { Request, Response } from 'express';
import { BaseController } from './BaseController';
import { logger } from '../../utils/logger';
import database from '../../config/database';
import redis from '../../config/redis';
import configManager from '../../config/app';
import minioManager from '../../config/minio';

/**
 * Health check controller for monitoring system status
 * Updated to include MinIO health checks
 */
export class HealthController extends BaseController {
  /**
   * GET /health
   * Basic health check endpoint
   */
  healthCheck = async (req: Request, res: Response): Promise<void> => {
    this.success(
      res,
      {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: configManager.getPackageConfig().npmPackageVersion,
        services: {
          database: database.isHealthy(),
          redis: redis.isHealthy(),
          minio: minioManager.isHealthy(),
        },
      },
      'Service is healthy'
    );
  };

  /**
   * GET /health/detailed
   * Detailed health check with dependencies including MinIO
   */
  detailedHealthCheck = async (req: Request, res: Response): Promise<void> => {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      minio: await this.checkMinio(),
      memory: this.checkMemory(),
      uptime: process.uptime(),
    };

    const isHealthy = checks.database.healthy && checks.redis.healthy && checks.minio.healthy;
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
      success: isHealthy,
      message: isHealthy ? 'All systems operational' : 'Some systems are unhealthy',
      data: {
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        checks,
      },
    });
  };

  private async checkDatabase(): Promise<{
    healthy: boolean;
    responseTime?: number;
    error?: string;
  }> {
    try {
      const { connected, latency } = await database.healthCheck();
      if (!connected) {
        logger.error('Database health check failed', {
          error: 'Database not connected',
        });
        return {
          healthy: false,
          error: 'Database not connected',
        };
      }
      return { healthy: true, responseTime: latency };
    } catch (error) {
      logger.error('Database health check failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async checkRedis(): Promise<{ healthy: boolean; responseTime?: number; error?: string }> {
    try {
      const { latency, connected } = await redis.healthCheck();
      if (!connected) {
        logger.error('Redis health check failed', {
          error: 'Redis not connected',
        });
        return {
          healthy: false,
          error: 'Redis not connected',
        };
      }
      return { healthy: true, responseTime: latency };
    } catch (error) {
      logger.error('Redis health check failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async checkMinio(): Promise<{
    healthy: boolean;
    responseTime?: number;
    bucketExists?: boolean;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      const healthResult = await minioManager.healthCheck();
      const responseTime = Date.now() - startTime;

      if (!healthResult.connected) {
        logger.error('MinIO health check failed', {
          error: healthResult.error || 'MinIO not connected',
        });
        return {
          healthy: false,
          error: healthResult.error || 'MinIO not connected',
          responseTime,
        };
      }

      return {
        healthy: true,
        responseTime,
        bucketExists: healthResult.bucketExists,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      logger.error('MinIO health check failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      };
    }
  }

  private checkMemory(): { usage: NodeJS.MemoryUsage; healthy: boolean } {
    const usage = process.memoryUsage();
    const maxHeapSize = 512 * 1024 * 1024; // 512MB threshold
    const healthy = usage.heapUsed < maxHeapSize;

    return { usage, healthy };
  }
}
