/**
 * Centralized logging utility with Loki integration and trace ID support
 * Provides structured logging with fallback to stdout
 */

import winston from 'winston';
import LokiTransport from 'winston-loki';
import { LogContext, LogLevel } from '@/types/logging';

class Logger {
  private logger: winston.Logger;

  private consoleFormat = (info: winston.Logform.TransformableInfo): string => {
    const { timestamp, level, message, traceId, ...meta } = info as any;
    const trace = traceId ? `[${traceId}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    return `${timestamp} ${level}: ${trace} ${message} ${metaStr}`;
  };

  constructor() {
    const transports: winston.transport[] = [
      // Always keep console transport as fallback
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(this.consoleFormat)
        ),
      }),
    ];

    // Add Loki transport if configured
    if (process.env.LOKI_HOST) {
      transports.push(
        new LokiTransport({
          host: process.env.LOKI_HOST,
          labels: {
            service: 'bulk-action-platform',
            environment: process.env.NODE_ENV || 'development',
          },
          json: true,
          format: winston.format.json(),
          replaceTimestamp: true,
          onConnectionError: err => {
            let fallbackMessage = 'Loki connection error, falling back to console';
            if (err instanceof Error) {
              fallbackMessage += `: ${err.message}`;
            }
            console.error(fallbackMessage);
          },
        })
      );
    }

    // Add file transports in development
    if (process.env.NODE_ENV === 'development') {
      transports.push(
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: winston.format.json(),
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          format: winston.format.json(),
        })
      );
    }

    this.logger = winston.createLogger({
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: {
        service: 'bulk-action-platform',
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      },
      transports,
    });
  }

  public info(message: string, context?: LogContext): void {
    this.logger.info(message, context);
  }

  public error(message: string, context?: LogContext & { error?: Error | string }): void {
    this.logger.error(message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.logger.warn(message, context);
  }

  public debug(message: string, context?: LogContext): void {
    this.logger.debug(message, context);
  }

  public verbose(message: string, context?: LogContext): void {
    this.logger.verbose(message, context);
  }

  // Method for logging with trace ID
  public withTrace(traceId: string) {
    return {
      info: (message: string, context?: Omit<LogContext, 'traceId'>) =>
        this.info(message, { ...context, traceId }),
      error: (
        message: string,
        context?: Omit<LogContext, 'traceId'> & { error?: Error | string }
      ) => this.error(message, { ...context, traceId }),
      warn: (message: string, context?: Omit<LogContext, 'traceId'>) =>
        this.warn(message, { ...context, traceId }),
      debug: (message: string, context?: Omit<LogContext, 'traceId'>) =>
        this.debug(message, { ...context, traceId }),
      verbose: (message: string, context?: Omit<LogContext, 'traceId'>) =>
        this.verbose(message, { ...context, traceId }),
    };
  }
}

// Export singleton instance
export const logger = new Logger();
export default logger;
