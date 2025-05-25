import configManager from './app';

const processingConfig = configManager.getProcessingConfig();
const rateLimitConfig = configManager.getRateLimitConfig();
const additionalFeatureConfig = configManager.getAdditionalFeatureConfig();
const contentLimitConfig = configManager.getContentLimitConfig();

export const securityConfig = {
  // File upload limits
  maxFileSize: processingConfig.maxFileSizeMB * 1024 * 1024, // e.g., 10MB
  maxCsvRows: processingConfig.maxCsvRows, // e.g., 10000 rows

  // Rate limiting
  rateLimitWindow: rateLimitConfig.windowMs,
  maxRequestsPerWindow: rateLimitConfig.maxRequests,

  // Allowed origins for CORS
  allowedOrigins: additionalFeatureConfig.allowedOrigins?.split(',') || ['http://localhost:3000'],

  // Content limits
  maxRequestSize: contentLimitConfig.maxRequestSize,
};
