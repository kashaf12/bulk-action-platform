import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { redisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { TooManyRequestsError } from '../../utils/error';

export interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (req: AuthenticatedRequest) => string;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
}

/**
 * Redis-based sliding window rate limiter
 * Specifically designed for bulk action endpoints
 */
export class RateLimiter {
  private options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions) {
    this.options = {
      keyGenerator: req => `rate_limit:${req.accountId}`,
      skipFailedRequests: false,
      skipSuccessfulRequests: false,
      ...options,
    };
  }

  middleware = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const key = this.options.keyGenerator(req);
    const now = Date.now();
    const window = this.options.windowMs;

    this.checkRateLimit(key, now, window)
      .then(({ allowed, remaining, resetTime }) => {
        // Add rate limit headers
        res.set({
          'X-RateLimit-Limit': this.options.maxRequests.toString(),
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': new Date(resetTime).toISOString(),
        });

        if (!allowed) {
          logger.warn('Rate limit exceeded', {
            traceId: req.traceId,
            accountId: req.accountId,
            key,
            limit: this.options.maxRequests,
            window: window / 1000, // Convert to seconds for logging
          });

          throw new TooManyRequestsError(
            `Rate limit exceeded. Maximum ${this.options.maxRequests} requests per ${window / 1000} seconds`,
            {
              limit: this.options.maxRequests,
              remaining: 0,
              resetTime: new Date(resetTime).toISOString(),
            }
          );
        }

        // Track request for rate limiting (increment counter)
        this.recordRequest(key, now, window).catch(error => {
          logger.error('Failed to record rate limit request', {
            traceId: req.traceId,
            error: error.message,
            key,
          });
        });

        logger.debug('Rate limit check passed', {
          traceId: req.traceId,
          accountId: req.accountId,
          remaining,
          limit: this.options.maxRequests,
        });

        next();
      })
      .catch(next);
  };

  private async checkRateLimit(
    key: string,
    now: number,
    window: number
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    try {
      const windowStart = now - window;
      const resetTime = now + window;

      // Use Redis pipeline for atomic operations
      const pipeline = redisClient.pipeline();

      // Remove expired entries
      pipeline.zremrangebyscore(key, 0, windowStart);

      // Count current requests in window
      pipeline.zcard(key);

      // Set expiration
      pipeline.expire(key, Math.ceil(window / 1000));

      const results = await pipeline.exec();

      if (!results) {
        throw new Error('Redis pipeline execution failed');
      }

      const currentCount = results[1][1] as number;
      const remaining = Math.max(0, this.options.maxRequests - currentCount);
      const allowed = currentCount < this.options.maxRequests;

      return { allowed, remaining, resetTime };
    } catch (error) {
      logger.error('Rate limit check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        key,
      });

      // Fail open - allow request if Redis is down
      return {
        allowed: true,
        remaining: this.options.maxRequests,
        resetTime: now + window,
      };
    }
  }

  private async recordRequest(key: string, now: number, window: number): Promise<void> {
    try {
      const pipeline = redisClient.pipeline();

      // Add current request with timestamp as score
      pipeline.zadd(key, now, `${now}-${Math.random()}`);

      // Remove entries older than window
      pipeline.zremrangebyscore(key, 0, now - window);

      // Set expiration
      pipeline.expire(key, Math.ceil(window / 1000));

      await pipeline.exec();
    } catch (error) {
      // Log error but don't fail the request
      logger.error('Failed to record rate limit request', {
        error: error instanceof Error ? error.message : 'Unknown error',
        key,
      });
    }
  }
}

/**
 * Rate limiter for bulk action creation (POST /bulk-actions)
 * Configurable through environment variables
 */
export const bulkActionRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: parseInt(process.env.BULK_ACTION_RATE_LIMIT || '10000'), // 10k rows per minute
  keyGenerator: req => `bulk_action_rate:${req.accountId}`,
});

export const createBulkActionRateLimit = bulkActionRateLimiter.middleware;
