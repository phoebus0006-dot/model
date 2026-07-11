export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends ApiError {
  constructor(message: string, requestId?: string) {
    super(message, 0, "NETWORK_ERROR", requestId);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends ApiError {
  constructor(requestId?: string) {
    super("Request timed out", 0, "TIMEOUT", requestId);
    this.name = "TimeoutError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(requestId?: string) {
    super("Unauthorized", 401, "UNAUTHORIZED", requestId);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends ApiError {
  constructor(path: string, requestId?: string) {
    super(`Not found: ${path}`, 404, "NOT_FOUND", requestId);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, requestId?: string) {
    super(message, 422, "VALIDATION_ERROR", requestId);
    this.name = "ValidationError";
  }
}
