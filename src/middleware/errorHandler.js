import { logger } from '../config/index.js';

/**
 * Global error handling middleware for Express
 */
export function errorHandler(err, req, res, next) {
  const correlationId = req?.id || req?.headers?.['x-correlation-id'] || 'system';

  // Handle malformed JSON request body
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn({ correlationId, err: err.message }, 'Malformed JSON payload received');
    return res.status(400).json({
      status: false,
      message: 'Invalid JSON payload received',
      correlationId,
    });
  }

  logger.error(
    {
      correlationId,
      err: {
        message: err.message,
        stack: err.stack,
        code: err.code,
      },
      url: req?.originalUrl,
      method: req?.method,
    },
    'Unhandled request error occurred'
  );

  const statusCode = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  res.status(statusCode).json({
    status: false,
    message: err.isOperational ? err.message : 'Internal Server Error',
    correlationId,
  });
}

/**
 * 404 Not Found fallback handler
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    status: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export default {
  errorHandler,
  notFoundHandler,
};
