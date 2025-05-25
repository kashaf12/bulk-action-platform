/**
 * Service and Repository interface definitions
 */

import { IEntity } from './base';
import { PaginationParams, PaginatedResult } from './pagination';

export interface IService {
  // Marker interface for services
}

export interface IRepository<T extends IEntity> {
  findAll(
    params: PaginationParams & Record<string, unknown>,
    traceId: string
  ): Promise<PaginatedResult<T>>;
  findById(id: string, traceId: string): Promise<T | null>;
  create(entity: T, traceId: string): Promise<T>;
  update(id: string, updates: Partial<T>, traceId: string): Promise<T | null>;
  delete(id: string, traceId: string): Promise<boolean>;
}
