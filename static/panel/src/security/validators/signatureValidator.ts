import { Validator, ValidationResult } from '../types';
import {
  MAGIC_SIGNATURES,
  SIGNATURE_READ_LENGTH,
  TEXT_LIKE_EXTENSIONS,
  TEXT_SNIFF_READ_LENGTH,
  SVG_SCAN_READ_LENGTH,
} from '../../../../../src/shared/security/config';
import { FileNormalizer } from '../../../../../src/shared/security/normalizer';
import {
  matchesMagicSignature,
  matchesDangerousMagic,
  looksLikeBinary,
  containsDangerousSvgMarkup,
} from '../../../../../src/shared/security/contentSniff';

// One read big enough to serve whichever branch below ends up firing, so a
// file only needs to be sliced once regardless of its extension.
const CONTENT_READ_LENGTH = Math.max(SIGNATURE_READ_LENGTH, TEXT_SNIFF_READ_LENGTH, SVG_SCAN_READ_LENGTH);

export class SignatureValidator implements Validator {
  public readonly name = 'SignatureValidator';

  public async validate(file: File): Promise<ValidationResult> {
    const normalizedName = FileNormalizer.normalizeFilename(file.name);
    const extension = FileNormalizer.extractExtension(normalizedName);

    const buffer = await file.slice(0, CONTENT_READ_LENGTH).arrayBuffer();
    const bytes = new Uint8Array(buffer);

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
          validator: this.name,
        };
      }
    }

    if (!extension) return { passed: true };

    const isMagicByte = extension in MAGIC_SIGNATURES;
    const isTextLike = TEXT_LIKE_EXTENSIONS.has(extension);
    const isSvg = extension === 'svg';
    // Extensions not in any signature table pass through — the dangerous
    // magic check above already caught any executable masquerading under them.
    if (!isMagicByte && !isTextLike && !isSvg) {
      return { passed: true };
    }

    if (isMagicByte) {
      if (bytes.length === 0) {
        return {
          passed: false,
          code: 'SIGNATURE_EMPTY_FILE',
          message: `The file is empty but claims to be a ${extension.toUpperCase()} file.`,
          validator: this.name,
        };
      }
      const expectedSignatures = MAGIC_SIGNATURES[extension as keyof typeof MAGIC_SIGNATURES];
      const matched = expectedSignatures.some((signature) => matchesMagicSignature(bytes, signature));
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

    if (isTextLike) {
      if (looksLikeBinary(bytes)) {
        return {
          passed: false,
          code: 'BINARY_CONTENT_MISMATCH',
          message: `This file contains binary data but claims to be a .${extension} text file.`,
          validator: this.name,
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
        validator: this.name,
      };
    }
    return { passed: true };
  }
}

