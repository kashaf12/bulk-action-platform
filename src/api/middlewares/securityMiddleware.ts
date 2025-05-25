import { Request, Response, NextFunction } from 'express';

/**
 * Request sanitization middleware
 * Prevents XSS and injection attacks
 */
export const sanitizationMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Sanitize request body
  if (req.body) {
    Object.assign(req.body, sanitizeObject(req.body));
  }

  // Sanitize query parameters
  if (req.query && Object.keys(req.query).length > 0) {
    Object.assign(req.query, sanitizeObject(req.query));
  }

  next();
};

function sanitizeObject(obj: any): any {
  // Handle string sanitation
  if (typeof obj === 'string') {
    return (
      obj
        // Remove script tags
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        // Remove javascript: protocol (with optional whitespace or obfuscation)
        .replace(/javascript\s*:/gi, '')
        // Remove inline event handlers like onclick=, onerror=, etc.
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
        .trim()
    );
  }

  // Handle arrays recursively
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  // Handle objects recursively, skip non-plain objects
  if (obj && typeof obj === 'object' && Object.prototype.toString.call(obj) === '[object Object]') {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        sanitized[key] = sanitizeObject(value);
      }
    }
    return sanitized;
  }

  // Return value as-is for other types (number, boolean, null, etc.)
  return obj;
}
