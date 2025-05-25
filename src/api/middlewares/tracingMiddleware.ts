import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';

export interface RequestWithTracing extends Request {
  traceId: string;
  startTime: number;
}

/**
 * Adds correlation ID and request timing to all requests
 * Enhances logging with trace context
 */
export const tracingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Generate unique trace ID for request correlation
  (req as RequestWithTracing).traceId = uuidv4();
  (req as RequestWithTracing).startTime = Date.now();

  // Add trace ID to response headers
  res.set('X-Trace-ID', (req as RequestWithTracing).traceId);

  // Log request start
  logger.info('Request started', {
    traceId: (req as RequestWithTracing).traceId,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
  });

  // Override res.json to include trace ID in responses
  const originalJson = res.json;
  res.json = function (body: any) {
    if (body && typeof body === 'object') {
      body.traceId = (req as RequestWithTracing).traceId;
    }
    return originalJson.call(this, body);
  };

  // Log request completion
  res.on('finish', () => {
    const duration = Date.now() - (req as RequestWithTracing).startTime;
    logger.info('Request completed', {
      traceId: (req as RequestWithTracing).traceId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    });
  });

  next();
};
