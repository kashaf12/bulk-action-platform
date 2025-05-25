/**
 * MinIO configuration and client management
 * Handles S3-compatible object storage for file uploads and processing
 */

import { Client as MinioClient } from 'minio';
import { logger } from '../utils/logger';
import configManager from './app';
import { MinioConfig } from '../types/minio';
import { Readable } from 'stream';

class MinioManager {
  private client: MinioClient | null = null;
  private config: MinioConfig;
  private isConnected = false;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Load MinIO configuration from environment variables
   */
  private loadConfig(): MinioConfig {
    const envConfig = configManager.getMinioConfig();
    return {
      endPoint: envConfig.endpoint,
      port: envConfig.port,
      useSSL: envConfig.useSSL,
      accessKey: envConfig.accessKey,
      secretKey: envConfig.secretKey,
      bucketName: envConfig.bucketName,
      region: envConfig.region,
    };
  }

  /**
   * Initialize MinIO client and ensure bucket exists
   */
  public async connect(): Promise<void> {
    try {
      this.client = new MinioClient({
        endPoint: this.config.endPoint,
        port: this.config.port,
        useSSL: this.config.useSSL,
        accessKey: this.config.accessKey,
        secretKey: this.config.secretKey,
        region: this.config.region,
      });

      // Test connection by checking if bucket exists
      const bucketExists = await this.client.bucketExists(this.config.bucketName);

      if (!bucketExists) {
        await this.client.makeBucket(this.config.bucketName, this.config.region);
        logger.info('MinIO bucket created', { bucketName: this.config.bucketName });
      }

      this.isConnected = true;
      logger.info('MinIO connected successfully', {
        endpoint: this.config.endPoint,
        port: this.config.port,
        bucket: this.config.bucketName,
        useSSL: this.config.useSSL,
      });
    } catch (error) {
      this.isConnected = false;
      logger.error('MinIO connection failed', {
        error: error instanceof Error ? error.message : String(error),
        config: {
          endpoint: this.config.endPoint,
          port: this.config.port,
          bucket: this.config.bucketName,
        },
      });
      throw error;
    }
  }

  /**
   * Get MinIO client instance
   */
  public getClient(): MinioClient {
    if (!this.client || !this.isConnected) {
      throw new Error('MinIO client not connected');
    }
    return this.client;
  }

  /**
   * Upload file stream to MinIO
   */
  public async uploadStream(
    objectPath: string,
    stream: Readable,
    size?: number,
    metadata?: Record<string, string>,
    traceId?: string
  ): Promise<{ etag: string; versionId?: string }> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();

      const uploadOptions: any = {};
      if (metadata) {
        uploadOptions.metadata = metadata;
      }

      const result = await client.putObject(
        this.config.bucketName,
        objectPath,
        stream,
        size,
        uploadOptions
      );

      log.info('File uploaded to MinIO successfully', {
        objectPath,
        bucketName: this.config.bucketName,
        etag: result.etag,
        size,
      });

      return { etag: result.etag, versionId: result.versionId || undefined };
    } catch (error) {
      log.error('Failed to upload file to MinIO', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
        bucketName: this.config.bucketName,
      });
      throw error;
    }
  }

  /**
   * Get file stream from MinIO
   */
  public async getFileStream(objectPath: string, traceId?: string): Promise<NodeJS.ReadableStream> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const stream = await client.getObject(this.config.bucketName, objectPath);

      log.debug('File stream retrieved from MinIO', {
        objectPath,
        bucketName: this.config.bucketName,
      });

      return stream;
    } catch (error) {
      log.error('Failed to get file stream from MinIO', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
        bucketName: this.config.bucketName,
      });
      throw error;
    }
  }

  /**
   * Check if file exists in MinIO
   */
  public async fileExists(objectPath: string, traceId?: string): Promise<boolean> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      await client.statObject(this.config.bucketName, objectPath);
      return true;
    } catch (error: any) {
      if (error.code === 'NotFound') {
        return false;
      }

      log.error('Failed to check file existence in MinIO', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
      });
      throw error;
    }
  }

  /**
   * Delete file from MinIO
   */
  public async deleteFile(objectPath: string, traceId?: string): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      await client.removeObject(this.config.bucketName, objectPath);

      log.info('File deleted from MinIO', {
        objectPath,
        bucketName: this.config.bucketName,
      });
    } catch (error) {
      log.error('Failed to delete file from MinIO', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
      });
      throw error;
    }
  }

  /**
   * Get file metadata from MinIO
   */
  public async getFileMetadata(objectPath: string, traceId?: string) {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const stat = await client.statObject(this.config.bucketName, objectPath);

      log.debug('File metadata retrieved from MinIO', {
        objectPath,
        size: stat.size,
        lastModified: stat.lastModified,
      });

      return {
        size: stat.size,
        lastModified: stat.lastModified,
        etag: stat.etag,
        metadata: stat.metaData,
      };
    } catch (error) {
      log.error('Failed to get file metadata from MinIO', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
      });
      throw error;
    }
  }

  /**
   * Generate presigned URL for direct access
   */
  public async getPresignedUrl(
    objectPath: string,
    expirySeconds: number = 3600,
    traceId?: string
  ): Promise<string> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const url = await client.presignedGetObject(
        this.config.bucketName,
        objectPath,
        expirySeconds
      );

      log.debug('Presigned URL generated', {
        objectPath,
        expirySeconds,
      });

      return url;
    } catch (error) {
      log.error('Failed to generate presigned URL', {
        error: error instanceof Error ? error.message : String(error),
        objectPath,
      });
      throw error;
    }
  }

  /**
   * List files with prefix
   */
  public async listFiles(prefix: string, traceId?: string): Promise<string[]> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const objects: string[] = [];

      const objectsStream = client.listObjects(this.config.bucketName, prefix, true);

      return new Promise((resolve, reject) => {
        objectsStream.on('data', obj => {
          if (obj.name) {
            objects.push(obj.name);
          }
        });

        objectsStream.on('end', () => {
          log.debug('Files listed from MinIO', {
            prefix,
            count: objects.length,
          });
          resolve(objects);
        });

        objectsStream.on('error', error => {
          log.error('Failed to list files from MinIO', {
            error: error.message,
            prefix,
          });
          reject(error);
        });
      });
    } catch (error) {
      log.error('Failed to list files from MinIO', {
        error: error instanceof Error ? error.message : String(error),
        prefix,
      });
      throw error;
    }
  }

  /**
   * Health check for MinIO
   */
  public async healthCheck(): Promise<{
    connected: boolean;
    bucketExists?: boolean;
    error?: string;
  }> {
    if (!this.client || !this.isConnected) {
      return {
        connected: false,
        error: 'MinIO client not connected',
      };
    }

    try {
      const bucketExists = await this.client.bucketExists(this.config.bucketName);
      return {
        connected: true,
        bucketExists,
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get bucket name
   */
  public getBucketName(): string {
    return this.config.bucketName;
  }

  /**
   * Close MinIO connection (cleanup)
   */
  public async close(): Promise<void> {
    if (this.client) {
      this.client = null;
      this.isConnected = false;
      logger.info('MinIO connection closed');
    }
  }

  /**
   * Check if MinIO is connected and healthy
   */
  public isHealthy(): boolean {
    return this.isConnected && this.client !== null;
  }
}

// Export singleton instance
const minioManager = new MinioManager();
export default minioManager;
export { MinioManager };
