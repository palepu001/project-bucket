import { MagicSignature } from './config';

// Pure, environment-agnostic content checks shared by the three places bytes
// get validated: the browser upload path, the browser migration path, and
// the server's post-upload re-check. Each caller supplies its own bytes (a
// File slice, a Blob slice, or a storage range-read) — nothing here does I/O.

// ---------------------------------------------------------------------------
// Dangerous content detection — the primary safety net. These signatures
// identify executable/script content by its actual bytes, regardless of what
// extension the file claims. A renamed `.exe` calling itself `.exr` or `.pdf`
// is caught here. The extension blocklist in config.ts is just the obvious
// first pass; this is the real defense.
// ---------------------------------------------------------------------------

interface DangerousSignature {
  /** Human-readable label for error messages. */
  label: string;
  /** Byte offset where this signature starts (0 for most formats). */
  offset: number;
  /** The expected byte sequence. */
  bytes: number[];
}

/**
 * Magic byte patterns that identify executable or script content. If a file's
 * header bytes match any of these, it is blocked unconditionally — no
 * extension, MIME type, or filename can override this verdict.
 */
const DANGEROUS_MAGIC: DangerousSignature[] = [
  // Windows PE / DOS executable (MZ header)
  { label: 'Windows executable (PE/DOS)', offset: 0, bytes: [0x4D, 0x5A] },
  // Linux ELF executable / shared library
  { label: 'Linux executable (ELF)', offset: 0, bytes: [0x7F, 0x45, 0x4C, 0x46] },
  // macOS Mach-O (32-bit, big-endian)
  { label: 'macOS executable (Mach-O)', offset: 0, bytes: [0xFE, 0xED, 0xFA, 0xCE] },
  // macOS Mach-O (64-bit, big-endian)
  { label: 'macOS executable (Mach-O 64)', offset: 0, bytes: [0xFE, 0xED, 0xFA, 0xCF] },
  // macOS Mach-O (32-bit, little-endian)
  { label: 'macOS executable (Mach-O LE)', offset: 0, bytes: [0xCE, 0xFA, 0xED, 0xFE] },
  // macOS Mach-O (64-bit, little-endian)
  { label: 'macOS executable (Mach-O 64 LE)', offset: 0, bytes: [0xCF, 0xFA, 0xED, 0xFE] },
  // macOS Universal Binary (fat binary)
  { label: 'macOS Universal Binary', offset: 0, bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  // Java class file
  { label: 'Java class file', offset: 0, bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  // Shell script / interpreter directive (#!)
  { label: 'Script with shebang', offset: 0, bytes: [0x23, 0x21] },
];

/**
 * Scans the first bytes of a file for known executable/script signatures.
 * Returns the human-readable label of the matched format, or null if the
 * content is not recognizably dangerous.
 *
 * This is the primary safety net — it catches dangerous content regardless
 * of file extension, so a renamed executable cannot slip through.
 */
export function matchesDangerousMagic(bytes: Uint8Array): string | null {
  for (const sig of DANGEROUS_MAGIC) {
    if (sig.offset + sig.bytes.length > bytes.length) continue;
    let matched = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[sig.offset + i] !== sig.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return sig.label;
  }
  return null;
}

export function matchesMagicSignature(bytes: Uint8Array, signature: MagicSignature): boolean {
  const { offset, bytes: expected } = signature;
  if (offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Heuristic used by git, `grep -I`, and most "is this text" checks: real
 * text never contains a NUL byte, and almost every binary format has one
 * within its first few hundred bytes. Not a parser — a sniff — but it is
 * enough to catch a binary blob renamed to an extension this app treats as
 * inert plain text (.txt, .json, .csv, ...) and previews unescaped.
 */
export function looksLikeBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

// SVG has no magic number — it is XML, and XML permits an optional BOM,
// declaration, comment, or DOCTYPE before the root element, so there is no
// fixed byte sequence to anchor on. What makes an SVG dangerous is markup,
// not bytes: an inline <script>, an on*= event handler, a javascript: URI,
// or a <foreignObject> smuggling in HTML. This is a denylist scoped to
// catching upload-time script injection — not a sanitizer, and not a claim
// that everything else is "safe" SVG.
const DANGEROUS_SVG_PATTERN = /<script[\s>]|on[a-z]+\s*=|javascript:|<foreignobject[\s>]/i;

export function containsDangerousSvgMarkup(text: string): boolean {
  return DANGEROUS_SVG_PATTERN.test(text);
}
