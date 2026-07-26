import { Validator, ValidationResult } from '../types';
import { validateStateless } from '../../../../../src/shared/security/validators/statelessPipeline';
import { FileNormalizer } from '../../../../../src/shared/security/normalizer';

/**
 * Adapter that runs the shared stateless pipeline on a browser File object.
 */
export class StatelessPipelineAdapter implements Validator {
  readonly name = 'StatelessPipeline';

  async validate(file: File): Promise<ValidationResult> {
    const payload = {
      filename: FileNormalizer.normalizeFilename(file.name),
      size: file.size,
      mimeType: file.type
    };
    return validateStateless(payload);
  }
}
