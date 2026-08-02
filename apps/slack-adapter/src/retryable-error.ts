export class RetryableWorkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetryableWorkError";
    this.code = code;
  }
}

export function isRetryableWorkError(error: unknown): error is RetryableWorkError {
  return error instanceof RetryableWorkError;
}
