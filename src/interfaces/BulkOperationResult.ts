export interface BulkOperationResult<T = any> {
  created: T[];
  updated: T[];
  skipped: T[];
  failed: Array<{ entity: T; error: string }>;
  totalProcessed: number;
  successCount: number;
  failureCount: number;
  skipCount: number;
}
