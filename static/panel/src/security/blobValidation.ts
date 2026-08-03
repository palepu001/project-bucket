import { validateStateless } from '../../../../src/shared/security/validators/statelessPipeline';
import { FileNormalizer } from '../../../../src/shared/security/normalizer';
import { SignatureValidator } from './validators/signatureValidator';
import { ValidationResult } from './types';

// Validation entry point for bytes that did NOT come from a file picker —
// specifically the Jira→Project Bucket migration, whose input is a Blob
// downloaded from the Jira attachment API plus a filename from SQL.
//
// The upload path gets these checks from createDefaultPipeline(); before this
// existed the migration path got none of them, so a file Jira accepted went
// straight to the storage location unexamined. Migrated content is the least
// trusted input the app handles, so it now runs the same checks:
//   1. stateless — filename, extension blocklist, MIME denylist, size
//   2. signature — dangerous magic detection (catches executables regardless
//      of extension) + format integrity for known types
//
// Malware scanning is deliberately NOT run here. The only scanner wired up
// today is MockScanner (always passes), so including it would add a round of
// theatre rather than a check. When a real engine lands it belongs in this
// function and in createDefaultPipeline together.
const signatureValidator = new SignatureValidator();

export async function validateMigratedBlob(
  blob: Blob,
  filename: string,
  mimeType: string
): Promise<ValidationResult> {
  const normalizedName = FileNormalizer.normalizeFilename(filename);

  const stateless = validateStateless({ filename: normalizedName, size: blob.size, mimeType });
  if (!stateless.passed) return stateless;

  // SignatureValidator reads `.name` and slices bytes, so hand it a File built
  // from the blob rather than duplicating the magic-number table.
  return signatureValidator.validate(new File([blob], normalizedName, { type: mimeType }));
}

