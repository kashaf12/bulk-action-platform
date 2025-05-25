/**
 * MinIO upload middleware replacing the original file security middleware
 * Integrates custom MinIO storage with Multer for direct streaming uploads
 */

import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { createMinioStorage } from '../../storage/minioStorage';
import { ValidationError } from '../../utils/error';
import { logger } from '../../utils/logger';

import configManager from '../../config/app';

const processingConfig = configManager.getProcessingConfig();

interface MinioMulterFile extends Express.Multer.File {
  etag: string;
  filePath: string;
  actionId: string;
}

/**
 * Create Multer instance with MinIO storage
 */
const createMinioUpload = () => {
  const storage = createMinioStorage({
    maxFileSize: processingConfig.maxFileSizeMB * 1024 * 1024,
    allowedMimeTypes: ['text/csv', 'application/csv', 'text/plain'],
  });

  return multer({
    storage,
    limits: {
      fileSize: processingConfig.maxFileSizeMB * 1024 * 1024,
      files: 1,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 1024 * 1024, // 1MB for other fields
    },
    fileFilter: (req, file, cb) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const log = logger.withTrace(authenticatedReq.traceId);

      // Additional file filtering if needed
      if (!file.originalname) {
        log.warn('File upload rejected: no filename provided');
        return cb(new ValidationError('Filename is required'));
      }

      // File type validation (also done in storage engine)
      const allowedMimeTypes = ['text/csv', 'application/csv', 'text/plain'];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        log.warn('File upload rejected: invalid MIME type', {
          mimetype: file.mimetype,
          filename: file.originalname,
        });
        return cb(new ValidationError(`Invalid file type: ${file.mimetype}`));
      }

      cb(null, true);
    },
  });
};

/**
 * MinIO file upload middleware
 */
export const minioFileUpload = createMinioUpload().single('file');

/**
 * Post-upload validation and processing middleware
 */
export const validateMinioUpload = (req: Request, res: Response, next: NextFunction): void => {
  const authenticatedReq = req as AuthenticatedRequest;
  const log = logger.withTrace(authenticatedReq.traceId);

  try {
    if (!authenticatedReq.file) {
      throw new ValidationError('No file uploaded');
    }

    const minioFile = authenticatedReq.file as MinioMulterFile;

    // Validate required MinIO-specific fields
    if (!minioFile.etag || !minioFile.filePath || !minioFile.actionId) {
      throw new ValidationError('Invalid file upload: missing MinIO metadata');
    }

    // Additional file size validation
    if (minioFile.size === 0) {
      throw new ValidationError('Uploaded file is empty');
    }

    // Validate file was actually uploaded to MinIO
    if (!minioFile.filePath.includes(authenticatedReq.accountId)) {
      throw new ValidationError('File path does not match account');
    }

    log.info('MinIO file upload validated successfully', {
      actionId: minioFile.actionId,
      filePath: minioFile.filePath,
      fileSize: minioFile.size,
      etag: minioFile.etag,
      originalName: minioFile.originalname,
    });

    // Attach additional metadata to request for controller use
    (req as any).minioFileInfo = {
      actionId: minioFile.actionId,
      filePath: minioFile.filePath,
      etag: minioFile.etag,
      fileSize: minioFile.size,
      originalName: minioFile.originalname,
      contentType: minioFile.mimetype,
    };

    next();
  } catch (error) {
    log.error('MinIO upload validation failed', {
      error: error instanceof Error ? error.message : String(error),
      file: req.file
        ? {
            originalname: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
          }
        : null,
    });
    next(error);
  }
};

/**
 * Cleanup middleware for failed uploads
 */
export const cleanupFailedUpload = (req: Request, res: Response, next: NextFunction): void => {
  const authenticatedReq = req as AuthenticatedRequest;
  // This middleware can be used to cleanup MinIO files if processing fails later
  // It should be placed after upload but before final response

  res.on('finish', () => {
    // If response was not successful and we have file info, we might want to cleanup
    if (res.statusCode >= 400 && (req as any)?.minioFileInfo) {
      const fileInfo = (req as any).minioFileInfo;
      logger
        .withTrace(authenticatedReq.traceId)
        .info('Response failed, file cleanup may be needed', {
          statusCode: res.statusCode,
          filePath: fileInfo.filePath,
          actionId: fileInfo.actionId,
        });

      // Note: Actual cleanup should be handled by the FileUploadService
      // This is just for logging/monitoring purposes
    }
  });

  next();
};
