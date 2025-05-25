/**
 * Logging-related type definitions
 */

export interface LogContext {
  traceId?: string;
  correlationId?: string;
  userId?: string;
  accountId?: string;
  [key: string]: unknown;
}

export interface LogData extends LogContext {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
  error?: Error | string;
  [key: string]: unknown;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';
