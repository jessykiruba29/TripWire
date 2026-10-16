/** Error envelope shared by the mock backend and the in-browser adapter. */
export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
export const notFound = (what, id) => new ApiError(404, 'not_found', `${what} ${id} not found`, { id });
export const validationError = (message, details) => new ApiError(422, 'validation_error', message, details);
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
