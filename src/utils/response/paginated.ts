/**
 * Paginated response utilities
 */

import { Response } from 'express';
import { PaginatedApiResponse, PaginationMeta } from '@/types';

export const sendPaginatedSuccess = <T>(
  res: Response,
  data: T[],
  pagination: PaginationMeta,
  message: string = 'Success',
  traceId?: string
): Response<PaginatedApiResponse<T>> => {
  const response: PaginatedApiResponse<T> = {
    success: true,
    message,
    data,
    pagination,
    timestamp: new Date().toISOString(),
    traceId,
  };

  return res.status(200).json(response);
};

export const createPaginationMeta = (
  page: number,
  limit: number,
  total: number
): PaginationMeta => {
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
};
