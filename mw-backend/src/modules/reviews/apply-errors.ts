export class ReviewDomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 422,
    public stage?: string,
  ) {
    super(message);
    this.name = "ReviewDomainError";
  }
}

export class ReviewNotFound extends ReviewDomainError {
  constructor(id: string) {
    super("REVIEW_NOT_FOUND", `Review item ${id} not found`, 404);
  }
}

export class InvalidReviewState extends ReviewDomainError {
  constructor(current: string, expected: string) {
    super("INVALID_REVIEW_STATE", `Current status "${current}" is not valid. Required: ${expected}`, 409);
  }
}

export class ApplyLockConflict extends ReviewDomainError {
  constructor(id: string) {
    super("APPLY_LOCK_CONFLICT", `Another apply is in progress for review item ${id}`, 409);
  }
}

export class ApplyDependencyError extends ReviewDomainError {
  constructor(stage: string, message: string) {
    super("APPLY_DEPENDENCY_ERROR", `Apply failed at ${stage}: ${message}`, 422, stage);
  }
}

export class ApplyValidationError extends ReviewDomainError {
  constructor(message: string) {
    super("APPLY_VALIDATION_ERROR", message, 422);
  }
}
