import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';
import { RequestWithTracing } from './tracingMiddleware';

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

/**
 * CSV file validation middleware
 * Validates uploaded CSV file headers and basic format
 */
export const csvValidationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authenticatedRequest = req as AuthenticatedRequest;
  try {
    if (!authenticatedRequest.file) {
      throw new ValidationError('CSV file is required');
    }

    const file = authenticatedRequest.file;

    // Validate file type
    if (!file.mimetype.includes('csv') && !file.originalname.endsWith('.csv')) {
      throw new ValidationError('File must be a CSV format');
    }

    // Validate file size (5MB limit from config)
    const maxFileSize = parseInt(process.env.MAX_FILE_SIZE_MB || '5') * 1024 * 1024;
    if (file.size > maxFileSize) {
      throw new ValidationError(`File size exceeds ${maxFileSize / 1024 / 1024}MB limit`);
    }

    // Basic header validation (we'll do detailed validation in workers)
    // const csvContent = file.buffer.toString('utf8');
    // const firstLine = csvContent.split('\n')[0];
    // const headers = firstLine.split(',').map(h => h.trim().toLowerCase());

    // const missingHeaders = requiredHeaders.filter(
    //   required => !headers.includes(required.toLowerCase())
    // );

    // if (missingHeaders.length > 0) {
    //   throw new ValidationError(`Missing required CSV headers: ${missingHeaders.join(', ')}`);
    // }

    // // Estimate row count (rough validation)
    // const estimatedRows = csvContent.split('\n').length - 1; // Exclude header
    // const maxRows = parseInt(process.env.MAX_CSV_ROWS || '10000');

    // if (estimatedRows > maxRows) {
    //   throw new ValidationError(`CSV contains too many rows. Maximum ${maxRows} allowed`);
    // }

    logger.info('CSV validation successful', {
      traceId: authenticatedRequest.traceId,
      fileName: file.originalname,
      fileSize: file.size,
      accountId: authenticatedRequest.accountId,
    });

    next();
  } catch (error) {
    next(error);
  }
};
