import type { ErrorCode } from './error-code';

/**
 * The wire contract. Every JSON response this service sends is an `ApiSuccess`
 * or an `ApiFailure`; clients discriminate on the presence of `error`.
 */

export interface ApiSuccess<T> {
  data: T;
}

/** One field-level reason a request was rejected. Populated for `VALIDATION_FAILED`. */
export interface ErrorDetail {
  /** Dot path to the offending field, e.g. `items.0.quantity`. Empty at the root. */
  path: string;
  /** The validator's own reason code, e.g. `invalid_type`. Narrower than `code`. */
  code: string;
  message: string;
}

export interface ApiError {
  /** Stable and machine-readable. Branch on this, never on `message`. */
  code: ErrorCode;
  /** Human-readable and free to be reworded. Not a contract. */
  message: string;
  details?: ErrorDetail[];
}

export interface ApiFailure {
  error: ApiError;
}
