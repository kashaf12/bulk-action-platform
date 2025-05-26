/**
 * Custom Multer storage engine for direct MinIO streaming
 * Streams files directly to MinIO without loading into memory
 */

import { Request } from 'express';
import { StorageEngine } from 'multer';
import { PassThrough } from 'stream';
import minioManager from '../config/minio';
import { PathGenerator } from './pathGenerator';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../api/middlewares/authenticationMiddleware';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/app';

interface MinioFile extends Express.Multer.File {
  etag: string;
  filePath: string;
  id: string;
}

export class MinioStorageEngine implements StorageEngine {
  private maxFileSize: number;
  private allowedMimeTypes: string[];

  constructor(
    options: {
      maxFileSize?: number;
      allowedMimeTypes?: string[];
    } = {}
  ) {
    this.maxFileSize = options.maxFileSize || 100 * 1024 * 1024; // 100MB default
    this.allowedMimeTypes = options.allowedMimeTypes || [
      'text/csv',
      'application/csv',
      'text/plain',
    ];
  }

  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error?: any, info?: Partial<Express.Multer.File>) => void
  ): void {
    const authenticatedReq = req as AuthenticatedRequest;
    const traceId = authenticatedReq.traceId;
    const accountId = authenticatedReq.accountId;
    const log = logger.withTrace(traceId);

    // Generate action ID for this upload
    const id = uuidv4();
    const filePath = PathGenerator.generateRawFilePath(accountId, id);

    log.info('Starting MinIO file upload', {
      accountId,
      id,
      originalName: file.originalname,
      mimetype: file.mimetype,
      filePath,
    });

    // Basic validation
    const validationError = this.validateFile(file);
    if (validationError) {
      log.warn('File validation failed', {
        error: validationError,
        file: file.originalname,
        mimetype: file.mimetype,
      });
      return callback(new Error(validationError));
    }

    // Create pass-through stream for monitoring
    const passThrough = new PassThrough();
    let uploadedBytes = 0;
    let headerValidated = false;
    let firstLine = '';

    // Monitor upload progress and validate headers
    passThrough.on('data', (chunk: Buffer) => {
      uploadedBytes += chunk.length;

      // Check file size limit
      if (uploadedBytes > this.maxFileSize) {
        log.warn('File size limit exceeded during upload', {
          uploadedBytes,
          maxFileSize: this.maxFileSize,
          filePath,
        });
        passThrough.destroy(new Error('File size limit exceeded'));
        return;
      }

      // Validate CSV headers from first chunk
      if (!headerValidated && chunk.length > 0) {
        const chunkStr = chunk.toString('utf8');
        const newlineIndex = chunkStr.indexOf('\n');

        if (newlineIndex !== -1) {
          firstLine += chunkStr.substring(0, newlineIndex);
          const headerError = this.validateCSVHeaders(firstLine);

          if (headerError) {
            log.warn('CSV header validation failed', {
              error: headerError,
              headers: firstLine.substring(0, 200), // Log first 200 chars
              filePath,
            });
            passThrough.destroy(new Error(headerError));
            return;
          }

          headerValidated = true;
          log.debug('CSV headers validated successfully', {
            headers: firstLine,
            filePath,
          });
        } else {
          firstLine += chunkStr;
          // If first chunk is too long without newline, it's probably not a valid CSV
          if (firstLine.length > 1000) {
            passThrough.destroy(new Error('Invalid CSV format: header line too long'));
            return;
          }
        }
      }
    });

    // Pipe file stream through our monitoring stream
    file.stream.pipe(passThrough);

    // Prepare metadata
    const metadata = {
      'original-filename': file.originalname,
      'content-type': file.mimetype,
      'account-id': accountId,
      'action-id': id,
      'upload-timestamp': new Date().toISOString(),
      'trace-id': traceId,
    };

    // Upload to MinIO
    minioManager
      .uploadStream(filePath, passThrough, undefined, metadata, traceId)
      .then(result => {
        log.info('File uploaded to MinIO successfully', {
          id,
          filePath,
          uploadedBytes,
          etag: result.etag,
          originalName: file.originalname,
        });

        // Return file info with additional MinIO-specific data
        const minioFile: Partial<MinioFile> = {
          fieldname: file.fieldname,
          originalname: file.originalname,
          encoding: file.encoding,
          mimetype: file.mimetype,
          size: uploadedBytes,
          filename: filePath.split('/').pop(),
          path: filePath,
          buffer: Buffer.alloc(0), // Empty buffer since we're streaming
          etag: result.etag,
          filePath: filePath,
          id,
        };

        callback(null, minioFile);
      })
      .catch(error => {
        log.error('MinIO upload failed', {
          error: error.message,
          id,
          filePath,
          uploadedBytes,
        });
        callback(error);
      });

    // Handle stream errors
    file.stream.on('error', error => {
      log.error('File stream error during upload', {
        error: error.message,
        id,
        filePath,
      });
      callback(error);
    });

    passThrough.on('error', error => {
      log.error('PassThrough stream error during upload', {
        error: error.message,
        id,
        filePath,
      });
      callback(error);
    });
  }

  _removeFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void
  ): void {
    const authenticatedReq = req as AuthenticatedRequest;
    const traceId = authenticatedReq.traceId;
    const minioFile = file as MinioFile;

    if (minioFile.filePath) {
      minioManager
        .deleteFile(minioFile.filePath, traceId)
        .then(() => {
          logger.withTrace(traceId).info('File removed from MinIO', {
            filePath: minioFile.filePath,
            id: minioFile.id,
          });
          callback(null);
        })
        .catch(error => {
          logger.withTrace(traceId).error('Failed to remove file from MinIO', {
            error: error.message,
            filePath: minioFile.filePath,
          });
          callback(error);
        });
    } else {
      callback(null);
    }
  }

  /**
   * Validate file type and basic properties
   */
  private validateFile(file: Express.Multer.File): string | null {
    // Check MIME type
    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      return `Invalid file type. Only CSV files are allowed. Received: ${file.mimetype}`;
    }

    // Check file extension
    const allowedExtensions = ['.csv', '.txt'];
    const fileExtension = file.originalname.toLowerCase().split('.').pop();
    if (!fileExtension || !allowedExtensions.includes(`.${fileExtension}`)) {
      return `Invalid file extension. Only ${allowedExtensions.join(', ')} are allowed`;
    }

    // Check filename for security
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\')
    ) {
      return 'Invalid filename: contains path traversal characters';
    }

    return null;
  }

  /**
   * Validate CSV headers (basic check)
   */
  private validateCSVHeaders(headerLine: string): string | null {
    if (!headerLine.trim()) {
      return 'CSV file appears to be empty';
    }

    // Basic CSV header validation
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    // Check for required 'email' header for contacts
    // if (!headers.includes('email')) {
    //   return 'CSV must contain an "email" column for contact processing';
    // }

    // Check for suspicious content in headers
    const suspiciousPatterns = [
      /^=.*/,
      /^@.*/,
      /^\+.*/,
      /^-.*/, // Formula injection
      /<script/i,
      /javascript:/i, // XSS attempts
    ];

    for (const header of headers) {
      for (const pattern of suspiciousPatterns) {
        if (pattern.test(header)) {
          return 'CSV headers contain potentially malicious content';
        }
      }
    }

    return null;
  }
}

/**
 * Create configured MinIO storage instance
 */
export function createMinioStorage(options?: {
  maxFileSize?: number;
  allowedMimeTypes?: string[];
}): MinioStorageEngine {
  const maxFileSize = config.getProcessingConfig().maxFileSizeMB;

  return new MinioStorageEngine({
    maxFileSize,
    allowedMimeTypes: ['text/csv', 'application/csv', 'text/plain'],
    ...options,
  });
}
