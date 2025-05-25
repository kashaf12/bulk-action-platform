import express, { Application } from 'express';
import cors from 'cors';
import compression from 'compression';
import { securityConfig } from '../config/security';
import {
  errorHandlerMiddleware,
  notFoundHandler,
  sanitizationMiddleware,
  tracingMiddleware,
} from './middlewares';
import routes from './routes';

/**
 * Create and configure Express application
 */
export function createApp(): Application {
  const app = express();

  // CORS configuration
  app.use(
    cors({
      origin: securityConfig.allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Account-ID', 'X-Trace-ID'],
    })
  );

  // Compression
  app.use(compression());

  // Body parsing middlewares
  app.use(
    express.json({
      limit: securityConfig.maxRequestSize,
      type: ['application/json'],
    })
  );

  app.use(
    express.urlencoded({
      extended: true,
      limit: securityConfig.maxRequestSize,
      parameterLimit: 20,
    })
  );

  // Request sanitization (should be after body parsing)
  app.use(sanitizationMiddleware);

  app.use(tracingMiddleware);

  // API routes (with versioning)
  // app.use('/api/v1', routes);
  app.use('/', routes);

  // Root endpoint redirect
  // app.get('/', (req, res) => {
  //   res.redirect('/api/v1');
  // });

  // 404 handler for non-API routes
  app.use(notFoundHandler);

  // Global error handler (must be last)
  app.use(errorHandlerMiddleware);

  return app;
}
