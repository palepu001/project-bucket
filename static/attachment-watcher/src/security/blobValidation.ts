import { validateStateless } from '../../../../src/shared/security/validators/statelessPipeline';
import { FileNormalizer } from '../../../../src/shared/security/normalizer';
import {
  MAGIC_SIGNATURES,
  SIGNATURE_READ_LENGTH,
  TEXT_LIKE_EXTENSIONS,
  TEXT_SNIFF_READ_LENGTH,
  SVG_SCAN_READ_LENGTH,
} from '../../../../src/shared/security/config';
import {
  matchesMagicSignature,
  matchesDangerousMagic,
  looksLikeBinary,
  containsDangerousSvgMarkup,
} from '../../../../src/shared/security/contentSniff';
import { ValidationResult } from '../../../../src/shared/security/types';

// Mirror of static/panel/src/security/blobValidation.ts — see that file's
// header for the rationale. Duplicated for the same reason migrationClient.ts
// is: the watcher is an independently bundled Custom UI resource, and wiring a
// cross-package build to share ~40 lines costs more than it saves. Neither the
// magic number table nor the byte-matching logic itself is duplicated —
// both sides import them from src/shared/security/, so the two can never
// disagree about what a PNG (or an SVG, or a .csv) looks like. Keep the two
// entry points in sync if this changes.

// One read big enough to serve whichever branch below ends up firing, so the
// blob only needs to be sliced once regardless of its extension.
const CONTENT_READ_LENGTH = Math.max(SIGNATURE_READ_LENGTH, TEXT_SNIFF_READ_LENGTH, SVG_SCAN_READ_LENGTH);

export async function validateMigratedBlob(
  blob: Blob,
  filename: string,
  mimeType: string
): Promise<ValidationResult> {
  const normalizedName = FileNormalizer.normalizeFilename(filename);

  const stateless = validateStateless({ filename: normalizedName, size: blob.size, mimeType });
  if (!stateless.passed) return stateless;

  const extension = FileNormalizer.extractExtension(normalizedName);

  const bytes = new Uint8Array(await blob.slice(0, CONTENT_READ_LENGTH).arrayBuffer());

  // PRIMARY SAFETY NET: detect dangerous executable/script content by its
  // actual bytes, regardless of what extension the file claims. A renamed
  // .exe calling itself .exr or .anything is caught here.
  if (bytes.length > 0) {
    const dangerousLabel = matchesDangerousMagic(bytes);
    if (dangerousLabel) {
      return {
        passed: false,
        code: 'DANGEROUS_CONTENT',
        message: `This file contains dangerous content (${dangerousLabel}) and cannot be uploaded.`,
        validator: 'SignatureValidator',
      };
    }
  }

  if (!extension) return { passed: true };

  const isMagicByte = extension in MAGIC_SIGNATURES;
  const isTextLike = TEXT_LIKE_EXTENSIONS.has(extension);
  const isSvg = extension === 'svg';
  // Extensions not in any signature table pass through — the dangerous
  // magic check above already caught any executable masquerading under them.
  if (!isMagicByte && !isTextLike && !isSvg) return { passed: true };

  if (isMagicByte) {
    if (bytes.length === 0) {
      return {
        passed: false,
        code: 'SIGNATURE_EMPTY_FILE',
        message: `The file is empty but claims to be a ${extension.toUpperCase()} file.`,
        validator: 'SignatureValidator',
      };
    }
    const expected = MAGIC_SIGNATURES[extension as keyof typeof MAGIC_SIGNATURES];
    if (!expected.some((signature) => matchesMagicSignature(bytes, signature))) {
      return {
        passed: false,
        code: 'SIGNATURE_MISMATCH',
        message: `${extension.toUpperCase()} signature is invalid. The file content does not match the expected format.`,
        validator: 'SignatureValidator',
      };
    }
    return { passed: true };
  }

  if (isTextLike) {
    if (looksLikeBinary(bytes)) {
      return {
        passed: false,
        code: 'BINARY_CONTENT_MISMATCH',
        message: `This file contains binary data but claims to be a .${extension} text file.`,
        validator: 'SignatureValidator',
      };
    }
    return { passed: true };
  }

  // isSvg
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (containsDangerousSvgMarkup(text)) {
    return {
      passed: false,
      code: 'SVG_UNSAFE_MARKUP',
      message: 'SVG files may not contain scripts or event handlers.',
      validator: 'SignatureValidator',
    };
  }
  return { passed: true };
}

