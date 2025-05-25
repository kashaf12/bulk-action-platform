/**
 * Storage-related type definitions
 */

export interface FileUploadResult {
  actionId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  etag: string;
  uploadedAt: Date;
}

export interface MinioUploadOptions {
  accountId: string;
  actionId: string;
  originalFileName: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface ChunkPathInfo {
  basePath: string;
  chunkPath: string;
  chunkFileName: string;
}

export interface FileValidationResult {
  isValid: boolean;
  errors: string[];
  fileSize?: number;
  contentType?: string;
}

export interface StreamUploadProgress {
  bytesUploaded: number;
  totalBytes?: number;
  percentage?: number;
}
