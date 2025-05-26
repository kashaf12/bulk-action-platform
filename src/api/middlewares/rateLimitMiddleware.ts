import { Request, Response, NextFunction } from 'express';
import redisManager from '../../config/redis'; // Import the default exported RedisManager instance
import { TooManyRequestsError, ServiceUnavailableError } from '../../utils/error'; // Ensure TooManyRequestsError and ServiceUnavailableError are available
import { logger } from '../../utils/logger';

import config from '../../config/app';

// Extend the Request type to include accountId and traceId
// These are assumed to be set by authenticationMiddleware and tracingMiddleware respectively
interface AuthenticatedRequestWithContext extends Request {
  accountId?: string;
  traceId?: string;
}

// Configuration for rate limiting
const RATE_LIMIT_EVENTS_PER_MINUTE = config.getRateLimitConfig().maxRequests; // 10,000 events per minute
const RATE_LIMIT_WINDOW_SECONDS = config.getRateLimitConfig().windowMs / 1000; // 1 minute (60 seconds)

export const rateLimitMiddleware = async (
  req: AuthenticatedRequestWithContext,
  res: Response,
  next: NextFunction
) => {
  const accountId = req.accountId;
  const traceId = req.traceId;

  // Log with traceId if available, otherwise use default logger
  const currentLogger = traceId ? logger.withTrace(traceId) : logger;

  if (!accountId) {
    // If no accountId, it means authenticationMiddleware likely didn't run or failed.
    // For bulk actions, an accountId is mandatory for rate limiting.
    currentLogger.warn('Rate Limit: Missing accountId for request, skipping rate limiting', {
      path: req.path,
    });
    // Decide whether to fail the request or continue. For critical bulk actions,
    // it's safer to fail if the identifier for rate limiting isn't present.
    return next(new TooManyRequestsError('Missing account identifier for rate limiting.'));
  }

  const key = `rate_limit:${accountId}`;
  const now = Date.now(); // Current timestamp in milliseconds

  try {
    // 1. Add current timestamp to the sorted set
    // The score and member are both the current timestamp in milliseconds
    await redisManager.zadd(key, now, now.toString(), traceId);

    // 2. Remove timestamps older than the window
    // Calculate the start of the current window (e.g., 60 seconds ago)
    const windowStart = now - RATE_LIMIT_WINDOW_SECONDS * 1000; // Convert seconds to milliseconds
    await redisManager.zremrangebyscore(key, '-inf', windowStart.toString(), traceId);

    // 3. Get the current count of events in the window
    const currentEventCount = await redisManager.zcard(key, traceId);

    // 4. Set an expiration on the key. This is a safety net.
    // If no new requests come for an account, the key will eventually expire.
    // Set it for slightly longer than the window to ensure clean up after inactivity.
    await redisManager.expire(key, RATE_LIMIT_WINDOW_SECONDS + 5, traceId); // +5 seconds buffer

    currentLogger.debug('Rate Limit Check', {
      traceId,
      accountId,
      currentEventCount,
      limit: RATE_LIMIT_EVENTS_PER_MINUTE,
      key,
    });

    if (currentEventCount > RATE_LIMIT_EVENTS_PER_MINUTE) {
      currentLogger.warn('Rate Limit Exceeded', {
        traceId,
        accountId,
        currentEventCount,
        limit: RATE_LIMIT_EVENTS_PER_MINUTE,
        path: req.path,
      });
      return next(
        new TooManyRequestsError(
          `Rate limit exceeded for account ${accountId}. Max ${RATE_LIMIT_EVENTS_PER_MINUTE} events per minute.`
        )
      );
    }

    next(); // Request allowed
  } catch (error) {
    currentLogger.error('Rate Limit Middleware Error', {
      traceId,
      accountId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: req.path,
    });
    // Decide on error handling:
    // 1. Fail closed (throw error): `next(error);` - safer for critical systems.
    // 2. Fail open (continue): `next();` - if the rate limiter itself shouldn't block traffic even if Redis is down.
    // Given it's a security/stability feature, failing closed is generally preferred.
    next(
      new ServiceUnavailableError(
        'Rate limiting service is currently unavailable. Please try again later.'
      )
    );
  }
};
