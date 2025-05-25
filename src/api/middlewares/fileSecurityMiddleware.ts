import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { ValidationError } from '../../utils/error';
import { logger } from '../../utils/logger';

// Allowed MIME types for CSV files
const ALLOWED_MIME_TYPES = ['text/csv', 'application/csv', 'text/plain'];

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.csv', '.txt'];

/**
 * Secure file upload configuration
 */
const storage = multer.memoryStorage();

const fileFilter = (
  req: AuthenticatedRequest,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  try {
    // Check MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      logger.warn('File upload rejected: Invalid MIME type', {
        traceId: req.traceId,
        accountId: req.accountId,
        mimetype: file.mimetype,
        filename: file.originalname,
      });
      return cb(new ValidationError(`Invalid file type. Only CSV files are allowed`));
    }

    // Check file extension
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      logger.warn('File upload rejected: Invalid extension', {
        traceId: req.traceId,
        accountId: req.accountId,
        extension: ext,
        filename: file.originalname,
      });
      return cb(
        new ValidationError(
          `Invalid file extension. Only ${ALLOWED_EXTENSIONS.join(', ')} are allowed`
        )
      );
    }

    // Check filename for path traversal
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\')
    ) {
      logger.warn('File upload rejected: Suspicious filename', {
        traceId: req.traceId,
        accountId: req.accountId,
        filename: file.originalname,
      });
      return cb(new ValidationError('Invalid filename'));
    }

    cb(null, true);
  } catch (error) {
    cb(error as Error);
  }
};

export const secureFileUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '5') * 1024 * 1024, // 5MB default
    files: 1, // Only one file per request
    fields: 10, // Limit number of fields
    fieldNameSize: 100, // Limit field name size
    fieldSize: 1024 * 1024, // Limit field value size to 1MB
  },
});

/**
 * CSV content security validation
 */
export const csvSecurityValidation = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.file) {
      return next();
    }

    const csvContent = req.file.buffer.toString('utf8');

    // Check for malicious CSV formulas
    const dangerousPatterns = [
      /^=.*/, // Excel formulas starting with =
      /^@.*/, // Excel formulas starting with @
      /^\+.*/, // Excel formulas starting with +
      /^-.*/, // Excel formulas starting with -
      /cmd\.exe/i,
      /powershell/i,
      /javascript:/i,
      /<script/i,
      /document\./i,
      /window\./i,
    ];

    const lines = csvContent.split('\n');
    for (let i = 0; i < Math.min(lines.length, 100); i++) {
      // Check first 100 lines
      const line = lines[i].trim();
      if (line) {
        const cells = line.split(',');
        for (const cell of cells) {
          const trimmedCell = cell.trim().replace(/^["']|["']$/g, ''); // Remove quotes

          for (const pattern of dangerousPatterns) {
            if (pattern.test(trimmedCell)) {
              logger.warn('CSV security violation detected', {
                traceId: req.traceId,
                accountId: req.accountId,
                line: i + 1,
                cell: trimmedCell.substring(0, 50), // Log first 50 chars only
                pattern: pattern.source,
              });

              throw new ValidationError(
                `Potentially malicious content detected in CSV at line ${i + 1}`
              );
            }
          }
        }
      }
    }

    logger.info('CSV security validation passed', {
      traceId: req.traceId,
      accountId: req.accountId,
      filename: req.file.originalname,
      size: req.file.size,
    });

    next();
  } catch (error) {
    next(error);
  }
};
