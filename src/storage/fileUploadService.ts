/**
 * File upload service for handling business logic around file uploads
 * Orchestrates MinIO upload with database operations
 */

import { BulkActionService } from '../services/BulkActionService';
import { BulkActionStatService } from '../services/BulkActionStatService';
import minioManager from '../config/minio';
import { logger } from '../utils/logger';
import { ValidationError, DatabaseError } from '../utils/error';
import { FileUploadResult, MinioUploadOptions } from '../types/storage';
import {
  BulkActionCreateData,
  BulkActionType,
  EntityType,
  BulkActionConfiguration,
} from '../types/entities/bulk-action';

export interface ProcessFileUploadRequest {
  accountId: string;
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  etag: string;
  entityType: EntityType;
  actionType: BulkActionType;
  configuration?: BulkActionConfiguration;
  scheduledAt?: Date;
}

export class FileUploadService {
  constructor(
    private bulkActionService: BulkActionService,
    private bulkActionStatService: BulkActionStatService
  ) {}

  /**
   * Process completed file upload and create bulk action
   */
  public async processFileUpload(
    request: ProcessFileUploadRequest,
    traceId: string
  ): Promise<{
    bulkAction: any;
    uploadResult: FileUploadResult;
  }> {
    const log = logger.withTrace(traceId);

    log.info('Processing file upload for bulk action', {
      accountId: request.accountId,
      id: request.id,
      filePath: request.filePath,
      fileSize: request.fileSize,
      entityType: request.entityType,
      actionType: request.actionType,
    });

    try {
      // Verify file exists in MinIO
      const fileExists = await minioManager.fileExists(request.filePath, traceId);
      if (!fileExists) {
        throw new ValidationError('Uploaded file not found in storage');
      }

      // Get file metadata for validation
      const metadata = await minioManager.getFileMetadata(request.filePath, traceId);
      if (metadata.size !== request.fileSize) {
        log.warn('File size mismatch detected', {
          expectedSize: request.fileSize,
          actualSize: metadata.size,
          filePath: request.filePath,
        });
      }

      // Estimate total entities from file size (rough estimation)
      const estimatedEntities = this.estimateEntityCount(request.fileSize, traceId);

      // Create bulk action in database
      const bulkActionData: BulkActionCreateData = {
        id: request.id,
        accountId: request.accountId,
        entityType: request.entityType,
        actionType: request.actionType,
        status: 'queued',
        totalEntities: estimatedEntities,
        processedEntities: 0,
        scheduledAt: request.scheduledAt,
        configuration: {
          ...request.configuration,
          filePath: request.filePath,
          fileName: request.fileName,
          fileSize: request.fileSize,
          contentType: request.contentType,
          etag: request.etag,
          estimatedEntities,
        },
      };

      const bulkAction = await this.bulkActionService.createBulkAction(
        {
          id: request.id,
          accountId: request.accountId,
          entityType: request.entityType,
          actionType: request.actionType,
          scheduledAt: request.scheduledAt,
          configuration: bulkActionData.configuration,
        },
        traceId
      );

      if (!bulkAction?.id) {
        throw new DatabaseError('Failed to create bulk action in database');
      }

      // Initialize statistics
      await this.bulkActionStatService.initializeStats(bulkAction!.id, estimatedEntities, traceId);

      // Create upload result
      const uploadResult: FileUploadResult = {
        id: request.id,
        filePath: request.filePath,
        fileName: request.fileName,
        fileSize: request.fileSize,
        contentType: request.contentType,
        etag: request.etag,
        uploadedAt: new Date(),
      };

      log.info('File upload processing completed successfully', {
        id: request.id,
        bulkId: bulkAction.id,
        filePath: request.filePath,
        estimatedEntities,
      });

      return {
        bulkAction,
        uploadResult,
      };
    } catch (error) {
      log.error('Failed to process file upload', {
        error: error instanceof Error ? error.message : String(error),
        id: request.id,
        filePath: request.filePath,
      });

      // Cleanup file from MinIO on processing failure
      try {
        await minioManager.deleteFile(request.filePath, traceId);
        log.info('Cleaned up file after processing failure', {
          filePath: request.filePath,
        });
      } catch (cleanupError) {
        log.error('Failed to cleanup file after processing failure', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          filePath: request.filePath,
        });
      }

      throw error;
    }
  }

  /**
   * Handle file upload failure cleanup
   */
  public async handleUploadFailure(filePath: string, id: string, traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);

    log.info('Handling upload failure cleanup', {
      filePath,
      id,
    });

    try {
      // Delete file from MinIO
      await minioManager.deleteFile(filePath, traceId);

      // Note: We don't clean up database entries here as they might not exist yet
      // The bulk action creation happens after successful upload

      log.info('Upload failure cleanup completed', {
        filePath,
        id,
      });
    } catch (error) {
      log.error('Failed to cleanup after upload failure', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
        id,
      });
      // Don't throw here as this is cleanup - log the error but continue
    }
  }

  /**
   * Get file download URL for workers
   */
  public async getFileDownloadUrl(
    filePath: string,
    expirySeconds: number = 3600,
    traceId: string
  ): Promise<string> {
    const log = logger.withTrace(traceId);

    try {
      const url = await minioManager.getPresignedUrl(filePath, expirySeconds, traceId);

      log.debug('Generated file download URL', {
        filePath,
        expirySeconds,
      });

      return url;
    } catch (error) {
      log.error('Failed to generate file download URL', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw error;
    }
  }

  /**
   * Validate file before processing
   */
  public async validateUploadedFile(
    filePath: string,
    expectedSize: number,
    expectedEtag: string,
    traceId: string
  ): Promise<boolean> {
    const log = logger.withTrace(traceId);

    try {
      // Check if file exists
      const exists = await minioManager.fileExists(filePath, traceId);
      if (!exists) {
        log.warn('File validation failed: file not found', { filePath });
        return false;
      }

      // Get file metadata
      const metadata = await minioManager.getFileMetadata(filePath, traceId);

      // Validate size
      if (metadata.size !== expectedSize) {
        log.warn('File validation failed: size mismatch', {
          filePath,
          expectedSize,
          actualSize: metadata.size,
        });
        return false;
      }

      // Validate ETag
      if (metadata.etag !== expectedEtag) {
        log.warn('File validation failed: ETag mismatch', {
          filePath,
          expectedEtag,
          actualEtag: metadata.etag,
        });
        return false;
      }

      log.debug('File validation passed', {
        filePath,
        size: metadata.size,
        etag: metadata.etag,
      });

      return true;
    } catch (error) {
      log.error('File validation error', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      return false;
    }
  }

  /**
   * Estimate entity count from file size (rough estimation)
   */
  private estimateEntityCount(fileSize: number, traceId: string): number {
    const log = logger.withTrace(traceId);

    // Rough estimation: average CSV row ~100-200 bytes
    // This is just for initial estimation, actual count will be determined during processing
    const averageBytesPerRow = 150;
    const estimatedRows = Math.floor(fileSize / averageBytesPerRow);

    // Subtract 1 for header row and ensure minimum of 0
    const estimatedEntities = Math.max(0, estimatedRows - 1);

    log.debug('Estimated entity count from file size', {
      fileSize,
      averageBytesPerRow,
      estimatedRows,
      estimatedEntities,
    });

    return estimatedEntities;
  }

  /**
   * Get upload progress (for potential future use with chunked uploads)
   */
  public async getUploadProgress(
    id: string,
    traceId: string
  ): Promise<{
    status: string;
    progress: number;
    message: string;
  }> {
    const log = logger.withTrace(traceId);

    try {
      // Get bulk action status
      const bulkAction = await this.bulkActionService.getBulkActionById(id, traceId);

      const progress =
        bulkAction.totalEntities > 0
          ? Math.round((bulkAction.processedEntities / bulkAction.totalEntities) * 100)
          : 0;

      return {
        status: bulkAction.status,
        progress,
        message: `Processing ${bulkAction.processedEntities} of ${bulkAction.totalEntities} entities`,
      };
    } catch (error) {
      log.error('Failed to get upload progress', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }
}
