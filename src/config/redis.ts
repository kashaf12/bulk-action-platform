/**
 * Redis configuration and connection management
 * Handles caching, rate limiting, and session management
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { ServiceUnavailableError } from '../utils/error';

import configManager from '../config/app';

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  database: number;
  connectTimeout: number;
  retryDelayOnFailover: number;
  maxRetriesPerRequest: number;
}

class RedisManager {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private config: RedisConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Load Redis configuration from environment variables
   */
  private loadConfig(): RedisConfig {
    const envConfig = configManager.getRedisConfig();

    return {
      host: envConfig.host,
      port: envConfig.port,
      password: envConfig.password,
      database: envConfig.database,
      connectTimeout: envConfig.connectTimeout,
      retryDelayOnFailover: envConfig.retryDelayOnFailover,
      maxRetriesPerRequest: envConfig.maxRetriesPerRequest,
    };
  }

  /**
   * Initialize Redis connection
   */
  public async connect(): Promise<void> {
    try {
      this.client = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
          connectTimeout: this.config.connectTimeout,
        },
        password: this.config.password,
        database: this.config.database,
      });

      // Handle Redis errors
      this.client.on('error', (err: Error) => {
        logger.error('Redis client error', { error: err.message });
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis connected successfully', {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
        });
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        logger.debug('Redis client ready');
      });

      this.client.on('end', () => {
        logger.info('Redis connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      this.isConnected = false;
      logger.error('Redis connection failed', {
        error: error instanceof Error ? error.message : String(error),
        config: {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
        },
      });
      throw new ServiceUnavailableError(`Redis connection failed: ${error}`);
    }
  }

  /**
   * Get Redis client instance
   */
  public getClient(): RedisClientType {
    if (!this.client || !this.isConnected) {
      throw new ServiceUnavailableError('Redis not connected');
    }
    return this.client;
  }

  /**
   * Set a key-value pair with optional expiration
   */
  public async set(
    key: string,
    value: string,
    ttlSeconds?: number,
    traceId?: string
  ): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();

      if (ttlSeconds) {
        await client.setEx(key, ttlSeconds, value);
      } else {
        await client.set(key, value);
      }

      log.debug('Redis SET operation successful', {
        key,
        ttl: ttlSeconds,
        valueLength: value.length,
      });
    } catch (error) {
      const log = traceId ? logger.withTrace(traceId) : logger;
      log.error('Redis SET operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis SET failed: ${error}`);
    }
  }

  /**
   * Get value by key
   */
  public async get(key: string, traceId?: string): Promise<string | null> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const value = await client.get(key);

      log.debug('Redis GET operation successful', {
        key,
        found: value !== null,
        valueLength: value?.length || 0,
      });

      return value;
    } catch (error) {
      log.error('Redis GET operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis GET failed: ${error}`);
    }
  }

  /**
   * Delete a key
   */
  public async del(key: string, traceId?: string): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.del(key);

      log.debug('Redis DEL operation successful', {
        key,
        deletedCount: result,
      });

      return result;
    } catch (error) {
      log.error('Redis DEL operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis DEL failed: ${error}`);
    }
  }

  /**
   * Increment a counter
   */
  public async incr(key: string, traceId?: string): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.incr(key);

      log.debug('Redis INCR operation successful', {
        key,
        newValue: result,
      });

      return result;
    } catch (error) {
      log.error('Redis INCR operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis INCR failed: ${error}`);
    }
  }

  /**
   * Set expiration for a key
   */
  public async expire(key: string, ttlSeconds: number, traceId?: string): Promise<boolean> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.expire(key, ttlSeconds);

      log.debug('Redis EXPIRE operation successful', {
        key,
        ttl: ttlSeconds,
        success: result,
      });

      return result === 1;
    } catch (error) {
      log.error('Redis EXPIRE operation failed', {
        key,
        ttl: ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis EXPIRE failed: ${error}`);
    }
  }
  /**
   * Check if key exists
   */
  public async exists(key: string, traceId?: string): Promise<boolean> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.exists(key);

      log.debug('Redis EXISTS operation successful', {
        key,
        exists: result === 1,
      });

      return result === 1;
    } catch (error) {
      log.error('Redis EXISTS operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis EXISTS failed: ${error}`);
    }
  }

  /**
   * Get multiple keys
   */
  public async mget(keys: string[], traceId?: string): Promise<(string | null)[]> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.mGet(keys);

      log.debug('Redis MGET operation successful', {
        keyCount: keys.length,
        foundCount: result.filter(v => v !== null).length,
      });

      return result;
    } catch (error) {
      log.error('Redis MGET operation failed', {
        keyCount: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis MGET failed: ${error}`);
    }
  }

  /**
   * Hash operations - set field in hash
   */
  public async hset(key: string, field: string, value: string, traceId?: string): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.hSet(key, field, value);

      log.debug('Redis HSET operation successful', {
        key,
        field,
        created: result === 1,
      });

      return result;
    } catch (error) {
      log.error('Redis HSET operation failed', {
        key,
        field,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis HSET failed: ${error}`);
    }
  }

  /**
   * Hash operations - get field from hash
   */
  public async hget(key: string, field: string, traceId?: string): Promise<string | null> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.hGet(key, field);

      log.debug('Redis HGET operation successful', {
        key,
        field,
        found: result !== null,
      });

      return result;
    } catch (error) {
      log.error('Redis HGET operation failed', {
        key,
        field,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis HGET failed: ${error}`);
    }
  }

  /**
   * Hash operations - get all fields from hash
   */
  public async hgetall(key: string, traceId?: string): Promise<Record<string, string>> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const result = await client.hGetAll(key);

      log.debug('Redis HGETALL operation successful', {
        key,
        fieldCount: Object.keys(result).length,
      });

      return result;
    } catch (error) {
      log.error('Redis HGETALL operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis HGETALL failed: ${error}`);
    }
  }

  /**
   * Rate limiting - increment with expiration (traditional fixed window counter)
   * This method is already present but is a different rate limiting approach
   */
  public async rateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number,
    traceId?: string
  ): Promise<{ allowed: boolean; current: number; remaining: number; resetTime: number }> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const client = this.getClient();
      const pipeline = client.multi();

      // Use pipeline for atomic operations
      pipeline.incr(key);
      pipeline.expire(key, windowSeconds);
      pipeline.ttl(key);

      const results = await pipeline.exec();

      if (!results || results.length !== 3) {
        throw new ServiceUnavailableError(`Invalid response from Redis pipeline`);
      }
      const current = typeof results[0] === 'number' ? results[0] : 0;
      const ttl = typeof results[2] === 'number' ? results[2] : 0;

      const allowed = current <= maxRequests;
      const remaining = Math.max(0, maxRequests - current);
      const resetTime = Date.now() + ttl * 1000;

      log.debug('Redis rate limit check', {
        key,
        current,
        maxRequests,
        allowed,
        remaining,
        windowSeconds,
      });

      return { allowed, current, remaining, resetTime };
    } catch (error) {
      log.error('Redis rate limit operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis rate limit failed: ${error}`);
    }
  }

  /**
   * Sorted Set operations - Add members to a sorted set
   */
  public async zadd(key: string, score: number, member: string, traceId?: string): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    try {
      const client = this.getClient();
      // The zAdd method in 'redis' package returns the number of elements added
      const result = await client.zAdd(key, { score, value: member });
      log.debug('Redis ZADD operation successful', { key, score, member, result });
      return result;
    } catch (error) {
      log.error('Redis ZADD operation failed', {
        key,
        score,
        member,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis ZADD failed: ${error}`);
    }
  }

  /**
   * Sorted Set operations - Remove members from a sorted set by score range
   */
  public async zremrangebyscore(
    key: string,
    min: string,
    max: string,
    traceId?: string
  ): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    try {
      const client = this.getClient();
      // The zRemRangeByScore method in 'redis' package returns the number of elements removed
      const result = await client.zRemRangeByScore(key, min, max);
      log.debug('Redis ZREMRANGEBYSCORE operation successful', { key, min, max, removed: result });
      return result;
    } catch (error) {
      log.error('Redis ZREMRANGEBYSCORE operation failed', {
        key,
        min,
        max,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis ZREMRANGEBYSCORE failed: ${error}`);
    }
  }

  /**
   * Sorted Set operations - Get the number of members in a sorted set
   */
  public async zcard(key: string, traceId?: string): Promise<number> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    try {
      const client = this.getClient();
      // The zCard method in 'redis' package returns the cardinality (number of elements) of the sorted set
      const result = await client.zCard(key);
      log.debug('Redis ZCARD operation successful', { key, count: result });
      return result;
    } catch (error) {
      log.error('Redis ZCARD operation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(`Redis ZCARD failed: ${error}`);
    }
  }

  /**
   * Health check for Redis
   */
  public async healthCheck(): Promise<{
    connected: boolean;
    latency?: number;
    memoryUsage?: string;
    error?: string;
  }> {
    if (!this.client || !this.isConnected) {
      return {
        connected: false,
        error: 'Redis not connected',
      };
    }

    const start = Date.now();

    try {
      await this.client.ping();
      const latency = Date.now() - start;

      // Get memory info
      const info = await this.client.info('memory');
      const memoryMatch = info.match(/used_memory_human:(.+)\r/);
      const memoryUsage = memoryMatch ? memoryMatch[1] : 'unknown';

      return {
        connected: true,
        latency,
        memoryUsage,
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Close Redis connection
   */
  public async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      logger.info('Redis connection closed');
    }
  }

  /**
   * Check if Redis is connected and healthy
   */
  public isHealthy(): boolean {
    return this.isConnected && this.client !== null;
  }
}

// Export singleton instance
const redisManager = new RedisManager();
export default redisManager;
