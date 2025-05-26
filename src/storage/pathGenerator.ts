/**
 * MinIO path generation utilities
 * Generates consistent file paths for different storage scenarios
 */

import { ChunkPathInfo } from '../types/storage';

export class PathGenerator {
  private static readonly BASE_PATH = 'private';

  /**
   * Generate path for raw uploaded file
   */
  public static generateRawFilePath(accountId: string, actionId: string): string {
    return `${this.BASE_PATH}/Accounts/${accountId}/Action/${actionId}/raw.csv`;
  }

  /**
   * Generate base path for chunks
   */
  public static generateChunksBasePath(accountId: string, actionId: string, jobId: string): string {
    return `${this.BASE_PATH}/Accounts/${accountId}/Action/${actionId}/Chunks/${jobId}`;
  }

  /**
   * Generate path for specific chunk file
   */
  public static generateChunkFilePath(
    accountId: string,
    actionId: string,
    jobId: string,
    chunkIndex: number
  ): string {
    const basePath = this.generateChunksBasePath(accountId, actionId, jobId);
    return `${basePath}/chunk${chunkIndex}.csv`;
  }

  /**
   * Parse account ID and action ID from file path
   */
  public static parseFilePathInfo(filePath: string): {
    accountId?: string;
    actionId?: string;
    fileType?: 'raw' | 'chunk' | 'processing';
  } | null {
    const pathRegex = new RegExp(
      `^${this.BASE_PATH}/Accounts/([^/]+)/Action/([^/]+)/(raw\\.csv|Chunks/[^/]+/chunk\\d+\\.csv|Chunks/processing/chunk_\\d+\\.csv|processing/.+)$`
    );
    const match = filePath.match(pathRegex);
    if (!match) {
      return null;
    }

    const [, accountId, actionId, fileTypePattern] = match;

    let fileType: 'raw' | 'chunk' | 'processing' = 'raw';

    if (fileTypePattern?.startsWith('Chunks/')) {
      fileType = 'chunk';
    } else if (fileTypePattern?.startsWith('Processing/')) {
      fileType = 'processing';
    }

    return {
      accountId,
      actionId,
      fileType,
    };
  }

  /**
   * Validate file path format
   */
  public static isValidFilePath(filePath: string): boolean {
    return this.parseFilePathInfo(filePath) !== null;
  }
}
