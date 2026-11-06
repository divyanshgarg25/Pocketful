export interface LogContext {
  requestId?: string;
  userId?: string;
  agent?: string;
  action?: string;
  [key: string]: unknown;
}

export class Logger {
  info(message: string, context?: LogContext): void {
    console.log(
      JSON.stringify({
        level: 'INFO',
        timestamp: new Date().toISOString(),
        message,
        ...context
      })
    );
  }

  warn(message: string, context?: LogContext): void {
    console.warn(
      JSON.stringify({
        level: 'WARN',
        timestamp: new Date().toISOString(),
        message,
        ...context
      })
    );
  }

  /**
   * logger.error(message, error?, context?)
   * Many callers pass their context object as the 2nd argument (`logger.error('x', { id })`). Treating that as an
   * "error" would stringify it to "[object Object]" and lose every field, so a plain object with no 3rd argument is
   * taken as the context.
   */
  error(message: string, error?: unknown, context?: LogContext): void {
    if (context === undefined && isPlainObject(error)) {
      context = error as LogContext;
      error = undefined;
    }
    const errorDetails =
      error === undefined
        ? {}
        : error instanceof Error
          ? { errorName: error.name, errorMessage: error.message, stack: error.stack }
          : { errorDetails: String(error) };

    console.error(
      JSON.stringify({
        level: 'ERROR',
        timestamp: new Date().toISOString(),
        message,
        ...errorDetails,
        ...context
      })
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Error) && Object.getPrototypeOf(v) === Object.prototype;
}

export const logger = new Logger();
