import { PayloadValidator, FilePayload, ValidationResult } from '../types';
import { FileNormalizer } from '../normalizer';
import { 
  MAX_FILENAME_LENGTH, 
  INVALID_FILENAME_CHARS, 
  RESERVED_FILENAMES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  DENIED_MIME_TYPES
} from '../config';

/**
 * Validates the file name to ensure it doesn't violate length constraints,
 * contain forbidden characters, or use reserved system names.
 */
export class FilenameValidator implements PayloadValidator {
  readonly name = 'FilenameValidator';

  validate(payload: FilePayload): ValidationResult {
    const filename = payload.filename;

    if (!filename || filename.trim() === '') {
      return { passed: false, code: 'INVALID_FILENAME', message: 'Filename cannot be empty.', validator: this.name };
    }

    if (filename.length > MAX_FILENAME_LENGTH) {
      return { passed: false, code: 'INVALID_FILENAME', message: `Filename exceeds the maximum length of ${MAX_FILENAME_LENGTH} characters.`, validator: this.name };
    }

    if (INVALID_FILENAME_CHARS.test(filename)) {
      return { passed: false, code: 'INVALID_FILENAME', message: 'Filename contains invalid characters.', validator: this.name };
    }

    const lastDotIndex = filename.lastIndexOf('.');
    const nameWithoutExt = lastDotIndex === -1 ? filename : filename.slice(0, lastDotIndex);
    
    if (RESERVED_FILENAMES.has(nameWithoutExt.toLowerCase())) {
      return { passed: false, code: 'INVALID_FILENAME', message: `'${nameWithoutExt}' is a reserved filename and cannot be used.`, validator: this.name };
    }

    if (/^\.+$/.test(filename)) {
      return { passed: false, code: 'INVALID_FILENAME', message: 'Filename cannot consist only of dots.', validator: this.name };
    }

    return { passed: true };
  }
}

/**
 * Validates the file extension to prevent uploads of unapproved file types.
 * Replaces the weak blocklist with a strict ALLOWED_EXTENSIONS whitelist.
 */
export class WhitelistValidator implements PayloadValidator {
  readonly name = 'WhitelistValidator';

  validate(payload: FilePayload): ValidationResult {
    const filename = payload.filename;
    const ext = FileNormalizer.extractExtension(filename);

    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return { passed: false, code: 'FORBIDDEN_EXTENSION', message: ext ? `'.${ext}' files are not allowed.` : 'Files without an extension are not allowed.', validator: this.name };
    }

    const segments = filename.split('.');
    if (segments.length > 2) { 
      for (let i = 1; i < segments.length; i++) {
        const segment = segments[i].toLowerCase();
        // If an inner segment is a known dangerous extension (meaning it's NOT in the whitelist, and it matches something risky, 
        // wait, we can't block just anything not in the whitelist because 'v1' is not in the whitelist.
        // We only want to block double extensions if they disguise a known dangerous type.
        // But since we use a whitelist, if someone uploads report.exe.pdf, the final extension is .pdf (allowed).
        // Is .exe allowed? No. Should we block ANY inner extension that is not in the whitelist? No, because 'v1' or 'backup' are not in the whitelist.
        // We should block inner segments that look like executables.
        // Since we removed the BLOCKED list, we can just hardcode a small list of highly dangerous inner extensions
        // or we can rely on the final extension.
        // Let's hardcode the most dangerous ones for the double extension check.
        if (['exe', 'bat', 'cmd', 'sh', 'js', 'vbs', 'msi', 'jar', 'scr', 'dll'].includes(segment)) {
          return { passed: false, code: 'FORBIDDEN_EXTENSION', message: 'The file appears to disguise a blocked extension.', validator: this.name };
        }
      }
    }

    return { passed: true };
  }
}

export class MimeValidator implements PayloadValidator {
  readonly name = 'MimeValidator';
  validate(payload: FilePayload): ValidationResult {
    const mimeType = payload.mimeType || 'application/octet-stream';
    if (DENIED_MIME_TYPES.has(mimeType.toLowerCase())) {
      return { passed: false, code: 'MIME_DENIED', message: `Files of type '${mimeType}' are not allowed.`, validator: this.name };
    }
    return { passed: true };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export class SizeValidator implements PayloadValidator {
  readonly name = 'SizeValidator';
  validate(payload: FilePayload): ValidationResult {
    if (payload.size > MAX_FILE_SIZE_BYTES) {
      return { passed: false, code: 'SIZE_EXCEEDED', message: `File exceeds the maximum size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`, validator: this.name };
    }
    return { passed: true };
  }
}

/**
 * Runs the stateless pipeline. Used by both backend API boundaries and the frontend UX layer.
 */
export function validateStateless(payload: FilePayload): ValidationResult {
  const validators: PayloadValidator[] = [
    new FilenameValidator(),
    new WhitelistValidator(),
    new MimeValidator(),
    new SizeValidator()
  ];

  for (const validator of validators) {
    let result: ValidationResult;
    try {
      result = validator.validate(payload);
    } catch (error) {
      return { passed: false, code: 'VALIDATOR_ERROR', message: 'Internal validation error.', validator: validator.name };
    }
    if (!result.passed) {
      return result;
    }
  }
  return { passed: true };
}
