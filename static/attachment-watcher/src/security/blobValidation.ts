import { validateStateless } from '../../../../src/shared/security/validators/statelessPipeline';
import { FileNormalizer } from '../../../../src/shared/security/normalizer';
import { MAGIC_SIGNATURES, SIGNATURE_READ_LENGTH } from '../../../../src/shared/security/config';
import { ValidationResult } from '../../../../src/shared/security/types';

// Mirror of static/panel/src/security/blobValidation.ts — see that file's
// header for the rationale. Duplicated for the same reason migrationClient.ts
// is: the watcher is an independently bundled Custom UI resource, and wiring a
// cross-package build to share ~40 lines costs more than it saves. The magic
// number table itself is NOT duplicated — both sides import it from
// src/shared/security/config.ts, so the two can never disagree about what a
// PNG looks like. Keep the two entry points in sync if this changes.

function matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

export async function validateMigratedBlob(
  blob: Blob,
  filename: string,
  mimeType: string
): Promise<ValidationResult> {
  const normalizedName = FileNormalizer.normalizeFilename(filename);

  const stateless = validateStateless({ filename: normalizedName, size: blob.size, mimeType });
  if (!stateless.passed) return stateless;

  const extension = FileNormalizer.extractExtension(normalizedName);
  // An extension with no known magic number (.txt, .csv, .log) is untestable
  // this way; the whitelist above already decided whether it is allowed at all.
  if (!extension || !(extension in MAGIC_SIGNATURES)) return { passed: true };

  const bytes = new Uint8Array(await blob.slice(0, SIGNATURE_READ_LENGTH).arrayBuffer());
  if (bytes.length === 0) {
    return {
      passed: false,
      code: 'SIGNATURE_EMPTY_FILE',
      message: `The file is empty but claims to be a ${extension.toUpperCase()} file.`,
      validator: 'SignatureValidator',
    };
  }

  const expected = MAGIC_SIGNATURES[extension as keyof typeof MAGIC_SIGNATURES];
  if (!expected.some((signature) => matchesSignature(bytes, signature))) {
    return {
      passed: false,
      code: 'SIGNATURE_MISMATCH',
      message: `${extension.toUpperCase()} signature is invalid. The file content does not match the expected format.`,
      validator: 'SignatureValidator',
    };
  }

  return { passed: true };
}
