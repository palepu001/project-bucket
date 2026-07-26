// F5 — Validation Pipeline type definitions. Every validator in the pipeline
// returns a ValidationResult, and every scanner implements MalwareScanner.
// These types are the contract between the pipeline runner, individual
// validators, and the upload service that consumes the pipeline's verdict.

/**
 * The outcome of running a single validator against a file.
 *
 * - `passed: true` means the file is acceptable according to this validator.
 * - `passed: false` includes a machine-readable `code`, a user-facing
 *   `message` (safe to show in the UI — never contains stack traces or
 *   internal details), and the `validator` name for structured logging.
 */
export type { ValidationResult } from '../../../../src/shared/security/types';
import { ValidationResult } from '../../../../src/shared/security/types';

/**
 * A single validation step in the pipeline. Validators are independent,
 * stateless, and composable — the pipeline runner calls them in order and
 * stops on the first failure.
 *
 * `validate` receives a browser `File` object and returns the result
 * asynchronously (some validators read bytes from the file, which is async).
 */
export interface Validator {
  /** Human-readable name used in logging and failure results. */
  readonly name: string;

  /** Run this validator against the given file. */
  validate(file: File): Promise<ValidationResult>;
}

/**
 * Abstraction for malware / content scanning. The current implementation
 * is `MockScanner` (always passes); future implementations will integrate
 * ClamAV, AWS, or another scanning service.
 *
 * The scanner receives the raw file bytes (as a browser `File`) and returns
 * a validation result. Implementations MUST NOT persist or transmit file
 * contents outside the scanning context, and MUST NOT log file contents.
 */
export interface MalwareScanner {
  /** Human-readable name of the scanning engine (e.g., "MockScanner", "ClamAV"). */
  readonly engineName: string;

  /** Scan the file and return a pass/fail result. */
  scan(file: File): Promise<ValidationResult>;
}
