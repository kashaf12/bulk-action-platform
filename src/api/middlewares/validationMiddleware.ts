import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';

export type ValidationType = 'body' | 'query' | 'params';

/**
 * Generic validation middleware factory using Zod schemas
 * Validates request body, query params, or route params
 */
export const validationMiddleware = <T>(schema: ZodSchema<T>, type: ValidationType = 'body') => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      let dataToValidate: any;

      switch (type) {
        case 'body':
          dataToValidate = req.body;
          break;
        case 'query':
          dataToValidate = req.query;
          break;
        case 'params':
          dataToValidate = req.params;
          break;
        default:
          dataToValidate = req.body;
      }

      const validatedData = schema.parse(dataToValidate);

      // Replace the original data with validated data
      switch (type) {
        case 'body':
          Object.assign(req.body, validatedData);
          break;
        case 'query':
          Object.assign(req.query, validatedData);
          break;
        case 'params':
          Object.assign(req.params, validatedData);
          break;
      }

      logger.debug('Validation successful', {
        traceId: (req as AuthenticatedRequest).traceId,
        type,
        accountId: (req as AuthenticatedRequest).accountId,
      });

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const validationErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
        }));

        logger.warn('Validation failed', {
          traceId: (req as AuthenticatedRequest).traceId,
          type,
          errors: validationErrors,
          accountId: (req as AuthenticatedRequest).accountId,
        });

        next(new ValidationError('Validation failed', validationErrors));
      } else {
        next(error);
      }
    }
  };
};
