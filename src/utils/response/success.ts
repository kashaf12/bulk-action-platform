/**
 * Success response utilities
 */

import { Response } from 'express';
import { ApiResponse } from '@/types/api';

export const sendSuccess = <T>(
  res: Response,
  data: T,
  message: string = 'Success',
  statusCode: number = 200,
  traceId?: string
): Response<ApiResponse<T>> => {
  const response: ApiResponse<T> = {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
    traceId: traceId,
  };

  return res.status(statusCode).json(response);
};

export const sendCreated = <T>(
  res: Response,
  data: T,
  message: string = 'Resource created successfully',
  traceId?: string
): Response<ApiResponse<T>> => {
  return sendSuccess(res, data, message, 201, traceId);
};

export const sendNoContent = (res: Response, traceId?: string): Response => {
  res.setHeader('X-Trace-ID', traceId || '');
  return res.status(204).send();
};
