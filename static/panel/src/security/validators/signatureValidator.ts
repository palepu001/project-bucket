import { Validator, ValidationResult } from '../types';
import { MAGIC_SIGNATURES, SIGNATURE_READ_LENGTH } from '../../../../../src/shared/security/config';
import { FileNormalizer } from '../../../../../src/shared/security/normalizer';

export class SignatureValidator implements Validator {
  public readonly name = 'SignatureValidator';

  public async validate(file: File): Promise<ValidationResult> {
    const normalizedName = FileNormalizer.normalizeFilename(file.name);
    const extension = FileNormalizer.extractExtension(normalizedName);

    // Whitelist enforcement guarantees an unknown extension NEVER reaches here if it's
    // part of the full pipeline. If it's a known extension with NO magic bytes
    // (e.g. .txt, .csv), pass it.
    if (!extension || !(extension in MAGIC_SIGNATURES)) {
      return { passed: true };
    }

    const slice = file.slice(0, SIGNATURE_READ_LENGTH);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.length === 0) {
      return {
        passed: false,
        code: 'SIGNATURE_EMPTY_FILE',
        message: `The file is empty but claims to be a ${extension.toUpperCase()} file.`,
        validator: this.name,
      };
    }

    const expectedSignatures = MAGIC_SIGNATURES[extension as keyof typeof MAGIC_SIGNATURES];
    let matched = false;

    for (const signature of expectedSignatures) {
      if (this.matchesSignature(bytes, signature)) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      return {
        passed: false,
        code: 'SIGNATURE_MISMATCH',
        message: `${extension.toUpperCase()} signature is invalid. The file content does not match the expected format.`,
        validator: this.name,
      };
    }

    return { passed: true };
  }

  private matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
    if (signature.length > bytes.length) {
      return false;
    }
    for (let i = 0; i < signature.length; i++) {
      if (bytes[i] !== signature[i]) {
        return false;
      }
    }
    return true;
  }
}
