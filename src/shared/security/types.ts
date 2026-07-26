// Resolves [BUG-01]: Types shared between frontend and backend.

/**
 * Validation outcome contract. Used identically on frontend and backend.
 */
export type ValidationResult =
  | { passed: true }
  | { passed: false; code: string; message: string; validator: string };

/**
 * Common payload properties verified by stateless validators.
 * This decoupled interface allows the backend to validate an API payload
 * without requiring a browser `File` object.
 */
export interface FilePayload {
  filename: string;
  size: number;
  mimeType: string;
}

/**
 * Shared validator interface.
 */
export interface PayloadValidator {
  readonly name: string;
  validate(payload: FilePayload): ValidationResult;
}
