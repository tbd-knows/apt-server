export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'AGENT_NOT_PROVISIONED',
  'AGENT_DISABLED',
  'INVALID_MESSAGE',
  'RUN_IN_PROGRESS',
  'RUN_NOT_FOUND',
  'UPSTREAM_FAILED',
  'SERVER_RESTARTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const statusByCode: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  AGENT_NOT_PROVISIONED: 409,
  AGENT_DISABLED: 403,
  INVALID_MESSAGE: 400,
  RUN_IN_PROGRESS: 409,
  RUN_NOT_FOUND: 404,
  UPSTREAM_FAILED: 502,
  SERVER_RESTARTED: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: error });
}
