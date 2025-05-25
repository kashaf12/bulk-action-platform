/**
 * Error response utilities
 */

import { Response } from 'express';
import { ApiErrorResponse } from '@/types/api';

export const sendError = (
  res: Response,
  message: string = 'Internal Server Error',
  statusCode: number = 500,
  details?: unknown,
  traceId?: string
): Response<ApiErrorResponse> => {
  const response: ApiErrorResponse = {
    success: false,
    message,
    timestamp: new Date().toISOString(),
    traceId,
  };

  if (details && process.env.NODE_ENV === 'development') {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};

export const sendValidationError = (
  res: Response,
  message: string = 'Validation failed',
  details?: unknown,
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, message, 400, details, traceId);
};

export const sendNotFound = (
  res: Response,
  resource: string = 'Resource',
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, `${resource} not found`, 404, undefined, traceId);
};

export const sendUnauthorized = (
  res: Response,
  message: string = 'Authentication required',
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, message, 401, undefined, traceId);
};

export const sendForbidden = (
  res: Response,
  message: string = 'Insufficient permissions',
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, message, 403, undefined, traceId);
};

export const sendConflict = (
  res: Response,
  message: string = 'Resource conflict',
  details?: unknown,
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, message, 409, details, traceId);
};

export const sendRateLimit = (
  res: Response,
  message: string = 'Rate limit exceeded',
  traceId?: string
): Response<ApiErrorResponse> => {
  return sendError(res, message, 429, undefined, traceId);
};
