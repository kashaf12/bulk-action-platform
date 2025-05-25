/**
 * API-related type definitions
 */

import { PaginationMeta } from './pagination';

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  timestamp: string;
  traceId?: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  details?: unknown;
  timestamp: string;
  traceId?: string;
}

export interface PaginatedApiResponse<T> extends ApiResponse<T[]> {
  pagination: PaginationMeta;
}

export interface AuthenticatedRequest {
  accountId: string;
  traceId: string;
}
