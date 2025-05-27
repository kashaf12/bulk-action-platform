import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authenticationMiddleware';
import { BaseController } from './BaseController';
import { BulkActionService } from '../../services/BulkActionService';
import { BulkActionStatService } from '../../services/BulkActionStatService';
import { FileUploadService } from '../../storage/fileUploadService';
import { logger } from '../../utils/logger';
import { NotFoundError, ValidationError } from '../../utils/error';
import { idParamSchema, bulkActionQuerySchema, createBulkActionRequestSchema } from '../../schemas';
import { ChunkingJobData } from '../../queues/types/ChunkingJob';
import chunkingQueue from '../../queues/ChunkingQueue';

/**
 * Controller for handling bulk action operations with MinIO file upload
 * Implements all bulk action endpoints with proper validation and error handling
 */
export class BulkActionController extends BaseController {
  private fileUploadService: FileUploadService;

  constructor(
    private bulkActionService: BulkActionService,
    private bulkActionStatService: BulkActionStatService
  ) {
    super();

    // Initialize file upload service
    this.fileUploadService = new FileUploadService(
      this.bulkActionService,
      this.bulkActionStatService
    );
  }

  /**
   * POST /bulk-actions
   * Create a new bulk action with MinIO CSV file upload
   */
  createBulkAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      // Validate request body
      const validatedBody = createBulkActionRequestSchema.parse(authenticatedRequest.body);

      // Validate MinIO file upload (set by minioUploadMiddleware)
      const minioFileInfo = (authenticatedRequest as any).minioFileInfo;
      if (!minioFileInfo) {
        throw new ValidationError('File upload failed or file information missing');
      }

      logger.info('Processing bulk action with MinIO upload', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        id: minioFileInfo.id,
        filePath: minioFileInfo.filePath,
        fileSize: minioFileInfo.fileSize,
        originalName: minioFileInfo.originalName,
        entityType: validatedBody.entityType,
        actionType: validatedBody.actionType,
      });

      try {
        // Process the uploaded file and create bulk action
        const result = await this.fileUploadService.processFileUpload(
          {
            accountId: authenticatedRequest.accountId,
            id: minioFileInfo.id,
            filePath: minioFileInfo.filePath,
            fileName: minioFileInfo.originalName,
            fileSize: minioFileInfo.fileSize,
            contentType: minioFileInfo.contentType,
            etag: minioFileInfo.etag,
            entityType: validatedBody.entityType,
            actionType: validatedBody.actionType,
            configuration: {
              ...validatedBody.configuration,
              uploadMetadata: {
                originalFileName: minioFileInfo.originalName,
                uploadedAt: new Date().toISOString(),
                traceId: authenticatedRequest.traceId,
              },
            },
            scheduledAt: validatedBody.scheduledAt
              ? new Date(validatedBody.scheduledAt)
              : undefined,
          },
          authenticatedRequest.traceId
        );

        logger.info('Bulk action created successfully with MinIO file', {
          traceId: authenticatedRequest.traceId,
          accountId: authenticatedRequest.accountId,
          id: result.bulkAction.id,
          filePath: result.uploadResult.filePath,
          totalEntities: result.bulkAction.totalEntities,
          status: result.bulkAction.status,
        });

        // Enqueue BullMQ job for chunking
        const chunkingJobData: ChunkingJobData = {
          traceId: authenticatedRequest.traceId,
          accountId: authenticatedRequest.accountId,
          actionId: result.bulkAction.id,
          createdAt: new Date().toISOString(),

          // File information
          filePath: result.uploadResult.filePath,
          fileName: result.uploadResult.fileName,
          fileSize: result.uploadResult.fileSize,
          etag: result.uploadResult.etag,

          // Action configuration
          entityType: validatedBody.entityType,
          actionType: validatedBody.actionType,
          configuration: {
            ...validatedBody.configuration,
            deduplicate: validatedBody.configuration?.deduplicate ?? false,
            onConflict: validatedBody.configuration?.onConflict ?? 'skip',
            chunkSize: 1000, // Default chunk size as requested
          },

          // Processing context
          estimatedEntityCount: result.bulkAction.totalEntities,
          scheduledAt: validatedBody.scheduledAt,
        };

        // Enqueue chunking job
        const chunkingJob = await chunkingQueue.addChunkingJob(
          chunkingJobData,
          {
            priority: 10, // High priority for new uploads
            attempts: 3,
            backoff: { type: 'exponential' },
            delay: validatedBody.scheduledAt
              ? new Date(validatedBody.scheduledAt).getTime() - Date.now()
              : 0,
          },
          authenticatedRequest.traceId
        );

        logger.info('Chunking job enqueued successfully', {
          traceId: authenticatedRequest.traceId,
          actionId: result.bulkAction.id,
          jobId: chunkingJob.id,
          scheduledAt: validatedBody.scheduledAt,
          estimatedEntityCount: result.bulkAction.totalEntities,
        });

        this.success(
          res,
          {
            id: result.bulkAction.id,
            status: result.bulkAction.status,
            totalEntities: result.bulkAction.totalEntities,
            scheduledAt: result.bulkAction.scheduledAt,
            createdAt: result.bulkAction.createdAt,
            file: {
              fileName: result.uploadResult.fileName,
              filePath: result.uploadResult.filePath,
              fileSize: result.uploadResult.fileSize,
              etag: result.uploadResult.etag,
              uploadedAt: result.uploadResult.uploadedAt,
            },
            processing: {
              message: 'File uploaded successfully and queued for processing',
              jobId: chunkingJob.id,
            },
          },
          'Bulk action created and queued for processing',
          201,
          authenticatedRequest.traceId
        );
      } catch (processingError) {
        // Handle file upload service errors
        logger.error('Bulk action processing failed', {
          traceId: authenticatedRequest.traceId,
          id: minioFileInfo.id,
          error:
            processingError instanceof Error ? processingError.message : String(processingError),
        });

        // Cleanup will be handled by FileUploadService
        throw processingError;
      }
    });
  };

  /**
   * GET /bulk-actions
   * List bulk actions with pagination and filtering (unchanged)
   */
  getBulkActions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const validatedQuery = bulkActionQuerySchema.parse(authenticatedRequest.query);

      logger.debug('Fetching bulk actions', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        filters: validatedQuery,
      });

      const { data, pagination } = await this.bulkActionService.getBulkActions(
        {
          accountId: authenticatedRequest.accountId,
          page: validatedQuery.page,
          limit: validatedQuery.limit,
        },
        authenticatedRequest.traceId
      );

      this.paginated(
        res,
        data.map(action => ({
          id: action.id,
          entityType: action.entityType,
          actionType: action.actionType,
          status: action.status,
          totalEntities: action.totalEntities,
          scheduledAt: action.scheduledAt,
          startedAt: action.startedAt,
          completedAt: action.completedAt,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt,
          // Include file information if available in configuration
          file: action.configuration?.filePath
            ? {
                fileName: action.configuration.fileName,
                filePath: action.configuration.filePath,
                fileSize: action.configuration.fileSize,
              }
            : undefined,
        })),
        pagination,
        'Bulk actions retrieved successfully',
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * GET /bulk-actions/{id}
   * Get detailed information about a specific bulk action (enhanced)
   */
  getBulkActionById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { id } = idParamSchema.parse(authenticatedRequest.params);

      logger.debug('Fetching bulk action details', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        id,
      });

      const bulkAction = await this.bulkActionService.getBulkActionById(
        id,
        authenticatedRequest.traceId
      );

      if (!bulkAction) {
        throw new NotFoundError('Bulk action not found');
      }

      // Get file download URL if file exists and user needs access
      let fileDownloadUrl: string | undefined;
      if (bulkAction.configuration?.filePath) {
        try {
          fileDownloadUrl = await this.fileUploadService.getFileDownloadUrl(
            bulkAction.configuration.filePath as string,
            3600, // 1 hour expiry
            authenticatedRequest.traceId
          );
        } catch (error) {
          logger.warn('Failed to generate file download URL', {
            traceId: authenticatedRequest.traceId,
            id,
            filePath: bulkAction.configuration.filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.success(
        res,
        {
          id: bulkAction.id,
          entityType: bulkAction.entityType,
          actionType: bulkAction.actionType,
          status: bulkAction.status,
          totalEntities: bulkAction.totalEntities,
          configuration: bulkAction.configuration,
          scheduledAt: bulkAction.scheduledAt,
          startedAt: bulkAction.startedAt,
          completedAt: bulkAction.completedAt,
          errorMessage: bulkAction.errorMessage,
          createdAt: bulkAction.createdAt,
          updatedAt: bulkAction.updatedAt,
          file: bulkAction.configuration?.filePath
            ? {
                fileName: bulkAction.configuration.fileName,
                filePath: bulkAction.configuration.filePath,
                fileSize: bulkAction.configuration.fileSize,
                downloadUrl: fileDownloadUrl,
                etag: bulkAction.configuration.etag,
              }
            : undefined,
        },
        'Bulk action details retrieved successfully',
        200,
        authenticatedRequest.traceId
      );
    });
  };
}
