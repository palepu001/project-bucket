// F5 — Validation Pipeline runner. Executes an ordered list of validators
// against a single file, stopping on the first failure. This is the core
// orchestration layer: validators are independent and composable, and the
// pipeline is the only thing that knows the execution order.
//
// The pipeline logs each validator's name and execution time for operational
// visibility, but NEVER logs file contents — that is a hard security rule.

import { Validator, ValidationResult } from './types';

/**
 * Runs an ordered sequence of validators against a file. Stops on the
 * first failure and returns that failure's result immediately — subsequent
 * validators are not invoked.
 *
 * Usage:
 *   const pipeline = new ValidationPipeline([validator1, validator2, ...]);
 *   const result = await pipeline.run(file);
 *   if (!result.passed) { /* show result.message to user *\/ }
 */
export class ValidationPipeline {
  private readonly validators: readonly Validator[];

  constructor(validators: Validator[]) {
    // Freeze the validator list so the pipeline's execution order can't be
    // mutated after construction — defense against accidental reordering.
    this.validators = Object.freeze([...validators]);
  }

  /**
   * Run all validators in order against the given file. Returns `{ passed:
   * true }` if every validator passes, or the first failure result.
   *
   * Timing is logged per-validator for operational monitoring. A thrown
   * exception from a validator is caught and converted into a structured
   * failure so the caller always gets a ValidationResult, never an
   * unhandled rejection.
   */
  async run(file: File): Promise<ValidationResult> {
    for (const validator of this.validators) {
      const startMs = performance.now();
      let result: ValidationResult;

      try {
        result = await validator.validate(file);
      } catch (error) {
        // A validator throwing is a bug, not a user error. Convert it to a
        // structured failure so the upload service can surface a message
        // instead of crashing. The error is logged for the developer, but
        // the user sees a generic message — no stack traces leak to the UI.
        const elapsedMs = (performance.now() - startMs).toFixed(1);
        console.error(
          `[ProjectBucket] Validator "${validator.name}" threw after ${elapsedMs}ms:`,
          error instanceof Error ? error.message : error
        );
        return {
          passed: false,
          code: 'VALIDATOR_ERROR',
          message: 'An internal validation error occurred. Please try again.',
          validator: validator.name,
        };
      }

      const elapsedMs = (performance.now() - startMs).toFixed(1);

      if (!result.passed) {
        // Log the failure for operational monitoring. The message is the
        // user-facing string — safe to log. File contents are never logged.
        console.warn(
          `[ProjectBucket] Validation failed: validator="${validator.name}" ` +
          `code="${result.code}" elapsed=${elapsedMs}ms ` +
          `file="${file.name}" size=${file.size}`
        );
        return result;
      }

      // Validator passed — log timing at debug level. In production, this
      // provides a performance baseline for each validator step.
      console.log(
        `[ProjectBucket] Validator "${validator.name}" passed in ${elapsedMs}ms ` +
        `file="${file.name}"`
      );
    }

    // Every validator passed.
    return { passed: true };
  }

  /** Returns the number of validators in this pipeline (useful for tests). */
  get length(): number {
    return this.validators.length;
  }
}
