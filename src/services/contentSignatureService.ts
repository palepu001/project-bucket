import { AttachmentStorageProvider } from '../storage/AttachmentStorageProvider';
import { FileNormalizer } from '../shared/security/normalizer';
import {
  MAGIC_SIGNATURES,
  SIGNATURE_READ_LENGTH,
  TEXT_LIKE_EXTENSIONS,
  TEXT_SNIFF_READ_LENGTH,
  SVG_SCAN_READ_LENGTH,
} from '../shared/security/config';
import { matchesMagicSignature, matchesDangerousMagic, looksLikeBinary, containsDangerousSvgMarkup } from '../shared/security/contentSniff';

// One read big enough to serve whichever branch below ends up firing, so the
// caller only needs a single range-read regardless of extension.
const CONTENT_READ_LENGTH = Math.max(SIGNATURE_READ_LENGTH, TEXT_SNIFF_READ_LENGTH, SVG_SCAN_READ_LENGTH);

/**
 * Server-side counterpart to the browser content validators.
 *
 * Browser validation gives immediate feedback, but it cannot be the trust
 * boundary: a caller can skip the UI and invoke resolvers directly. This reads
 * only the object header from the storage provider after upload and before
 * metadata persistence.
 */
export async function assertStoredObjectMatchesFilename(
  provider: AttachmentStorageProvider,
  ref: string,
  filename: string
): Promise<void> {
  const normalizedName = FileNormalizer.normalizeFilename(filename);
  const extension = FileNormalizer.extractExtension(normalizedName);

  // PRIMARY SAFETY NET: detect dangerous executable/script content by its
  // actual bytes, regardless of what extension the file claims. This is the
  // backend trust boundary — a caller that skips the browser UI entirely
  // is caught here. Read the header BEFORE any extension-specific check.
  const bytes = await provider.readHeaderBytes(ref, CONTENT_READ_LENGTH);
  if (bytes && bytes.length > 0) {
    const dangerousLabel = matchesDangerousMagic(bytes);
    if (dangerousLabel) {
      throw new Error(
        `"${filename}" was rejected — the stored bytes are ${dangerousLabel}. ` +
        'Executable content is not allowed regardless of file extension.'
      );
    }
  }

  if (!extension) return;

  const isMagicByte = extension in MAGIC_SIGNATURES;
  const isTextLike = TEXT_LIKE_EXTENSIONS.has(extension);
  const isSvg = extension === 'svg';
  if (!isMagicByte && !isTextLike && !isSvg) return;

  if (isMagicByte) {
    if (!bytes || bytes.length === 0) {
      throw new Error(`"${filename}" is empty or missing, but claims to be a ${extension.toUpperCase()} file.`);
    }
    const expected = MAGIC_SIGNATURES[extension as keyof typeof MAGIC_SIGNATURES];
    if (!expected.some((signature) => matchesMagicSignature(bytes, signature))) {
      throw new Error(
        `"${filename}" failed content validation. The stored bytes do not match the .${extension} file type.`
      );
    }
    return;
  }

  if (!bytes) {
    throw new Error(`"${filename}" could not be read back from storage for content validation.`);
  }

  if (isTextLike) {
    if (looksLikeBinary(bytes)) {
      throw new Error(`"${filename}" contains binary data but claims to be a .${extension} text file.`);
    }
    return;
  }

  // isSvg
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (containsDangerousSvgMarkup(text)) {
    throw new Error(`"${filename}" was rejected — SVG files may not contain scripts or event handlers.`);
  }
}

