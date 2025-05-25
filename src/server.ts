// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './api/app';
import { logger } from './utils/logger';
import configManager from './config/app';
import database from './config/database';
import redis from './config/redis';

const appConfig = configManager.getAppConfig();
const PORT = appConfig.port;
const NODE_ENV = appConfig.nodeEnv;

/**
 * Start the server with proper initialization and cleanup
 */
async function startServer(): Promise<void> {
  try {
    logger.info('Starting Bulk Action Platform API server', {
      port: PORT,
      environment: NODE_ENV,
      nodeVersion: process.version,
    });

    // Initialize database connection
    try {
      await database.connect();
      logger.info('Database connection established');
    } catch (error) {
      logger.error('Database connection failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }

    // // Initialize Redis connection
    // try {
    //   await redis.connect();
    //   logger.info('Redis connection established');
    // } catch (error) {
    //   logger.error('Redis connection failed', {
    //     error: error instanceof Error ? error.message : 'Unknown error',
    //   });
    //   throw error;
    // }

    // Create and start Express app
    const app = createApp();

    const server = app.listen(PORT, () => {
      logger.info('Server started successfully', {
        port: PORT,
        environment: NODE_ENV,
        processId: process.pid,
      });
    });

    // Graceful shutdown handling
    const gracefulShutdown = (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          // Close database connections
          await database.close();
          logger.info('Database connections closed');

          // Close Redis connections
          await redis.close();
          logger.info('Redis connections closed');

          logger.info('Graceful shutdown completed');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          process.exit(1);
        }
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('Forced shutdown due to timeout');
        process.exit(1);
      }, 30000);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', error => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled promise rejection', {
        reason,
        promise,
      });
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

// Start the server
startServer();
