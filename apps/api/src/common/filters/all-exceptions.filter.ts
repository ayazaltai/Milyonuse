import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ErrorCode, type ErrorResponse, errorStatus } from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../app-error.js';
import { AppLogger, requestContext } from '../logging/logger.js';

/**
 * Single exit point for every failure.
 *
 * Two rules hold here. First, the response shape is always ErrorResponse, so a
 * client never has to guess whether a failure is JSON or a stack trace. Second,
 * an unrecognised exception becomes a bare internal_error: the requestId lets
 * an operator find the detail in the logs, and the client learns nothing about
 * the internals.
 */
/**
 * The line for a refusal — a 4xx, or a 5xx that is the system working as
 * designed. Written to standard error as a warning; the kept system log
 * (modules/observability) leaves most of them out, as the answer the caller
 * got is the whole of the story.
 */
export const REQUEST_REJECTED = 'request rejected';

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = requestContext.getStore()?.requestId ?? 'unknown';

    const { status, body } = this.translate(exception, requestId);

    if (status >= 500) {
      this.logger.error('request failed', {
        code: body.error.code,
        status,
        err: exception instanceof Error ? exception.stack : String(exception),
        ...(exception instanceof AppError && exception.context ? exception.context : {}),
      });
    } else {
      this.logger.warn(REQUEST_REJECTED, { code: body.error.code, status });
    }

    void reply.status(status).send(body);
  }

  private translate(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ErrorResponse } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
            requestId,
          },
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: errorStatus[ErrorCode.VALIDATION_FAILED],
        body: {
          error: {
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Request validation failed',
            details: exception.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.MALFORMED_REQUEST,
            message: exception.message,
            requestId,
          },
        },
      };
    }

    return {
      status: errorStatus[ErrorCode.INTERNAL_ERROR],
      body: {
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }
}
