import { Response, NextFunction } from 'express';
import { SecureAuthenticatedRequest } from './enhancedAuthMiddleware';
import { logger } from '../../utils/logger';

/**
 * Audit logging for sensitive operations
 */
export const auditMiddleware = (action: string) => {
  return (req: SecureAuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Log the audit event
    logger.info('Audit log', {
      traceId: req.traceId,
      action,
      accountId: req.accountId,
      sessionId: req.sessionId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
      requestSize: req.get('Content-Length') || 0,
    });

    // Override response to log completion
    const originalSend = res.send;
    res.send = function (body: any) {
      logger.info('Audit completion', {
        traceId: req.traceId,
        action,
        accountId: req.accountId,
        statusCode: res.statusCode,
        responseSize: body ? body.length : 0,
      });
      return originalSend.call(this, body);
    };

    next();
  };
};
