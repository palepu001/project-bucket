// Security configuration shared between frontend and backend boundaries.
// Block dangerous file types (executables, scripts) and allow everything else.
// Project Bucket is a storage product — it stores and serves files, never
// executes them — so the realistic threat surface is executable content
// disguised as something benign, not the universe of unknown formats.

export const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024; // 256 MB
export const MAX_FILENAME_LENGTH = 255;
export const INVALID_FILENAME_CHARS = /[\/\\<>"|?*\x00-\x1f]/;

export const RESERVED_FILENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Whitelist of allowed extensions.
 * If a file extension is not explicitly listed here, it is completely blocked.
 * This prevents executable Java archives (.jar), Mac apps (.app), Windows shortcuts (.lnk),
 * and other dangerous extensions from slipping through an incomplete blocklist.
 */
export const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tiff', 'tif',
  'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'csv',
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
  'mp3', 'wav', 'ogg',
  'mp4', 'mov', 'webm',
  'exr', 'blend', 'nk' // VFX formats
]);

/**
 * MIME types that are explicitly denied. 
 * Whitelisting extensions handles 99% of threats, but checking MIME types
 * provides a defense-in-depth layer against spoofing where the browser detects
 * the true type.
 */
export const DENIED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-msi',
  'application/x-hta',
  'application/vnd.microsoft.portable-executable',
]);

export interface MagicSignature {
  // Byte offset into the file where this signature must start. Zero for
  // almost everything — a handful of container formats put their marker
  // partway into the header instead of at byte 0 (see mp4/mov/tar below).
  offset: number;
  bytes: number[];
}

// Shorthand for the common case: a signature anchored at the start of the file.
const at0 = (bytes: number[]): MagicSignature => ({ offset: 0, bytes });

/**
 * Magic number signature map. Only applies to files with extensions in ALLOWED_EXTENSIONS
 * that also have known magic numbers — see TEXT_LIKE_EXTENSIONS and 'svg' for
 * how the remaining allowed extensions are content-checked instead.
 */
export const MAGIC_SIGNATURES: Record<string, MagicSignature[]> = {
  pdf: [at0([0x25, 0x50, 0x44, 0x46])],
  png: [at0([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  jpg: [at0([0xFF, 0xD8, 0xFF])],
  jpeg: [at0([0xFF, 0xD8, 0xFF])],
  zip: [at0([0x50, 0x4B, 0x03, 0x04])],
  docx: [at0([0x50, 0x4B, 0x03, 0x04])],
  xlsx: [at0([0x50, 0x4B, 0x03, 0x04])],
  pptx: [at0([0x50, 0x4B, 0x03, 0x04])],
  gif: [
    at0([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
    at0([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  ],
  bmp: [at0([0x42, 0x4D])],
  webp: [at0([0x52, 0x49, 0x46, 0x46])],
  doc: [at0([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  xls: [at0([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  ppt: [at0([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  odt: [at0([0x50, 0x4B, 0x03, 0x04])],
  ods: [at0([0x50, 0x4B, 0x03, 0x04])],
  odp: [at0([0x50, 0x4B, 0x03, 0x04])],
  gz: [at0([0x1F, 0x8B])],
  tgz: [at0([0x1F, 0x8B])],
  rar: [at0([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])],
  '7z': [at0([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])],
  bz2: [at0([0x42, 0x5A, 0x68])],
  mp3: [at0([0x49, 0x44, 0x33]), at0([0xFF, 0xFB]), at0([0xFF, 0xF3]), at0([0xFF, 0xFA]), at0([0xFF, 0xF2])],
  wav: [at0([0x52, 0x49, 0x46, 0x46])],
  ogg: [at0([0x4F, 0x67, 0x67, 0x53])],
  tiff: [at0([0x49, 0x49, 0x2A, 0x00]), at0([0x4D, 0x4D, 0x00, 0x2A])],
  tif: [at0([0x49, 0x49, 0x2A, 0x00]), at0([0x4D, 0x4D, 0x00, 0x2A])],
  webm: [at0([0x1A, 0x45, 0xDF, 0xA3])],
  // ISO Base Media container ("ftyp" box). Not at offset 0 — the first 4
  // bytes are the box size, which varies — but every real MP4/MOV file has
  // this box starting at byte 4. QuickTime (.mov) and MPEG-4 (.mp4) share
  // the same box name; only the brand that follows differs, which this
  // check does not need to distinguish.
  mp4: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  mov: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  // POSIX ustar / GNU tar magic at byte 257. Pre-POSIX ("v7") tar has no
  // magic number anywhere in its header and cannot be distinguished this
  // way — an accepted, documented gap, since v7 tar is effectively extinct
  // among files a browser would produce or a user would upload today.
  tar: [{ offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] }],
  exr: [at0([0x76, 0x2F, 0x31, 0x01]), at0([0x76, 0x2F, 0x31, 0x02])],
};

// Longest read any MAGIC_SIGNATURES entry needs: tar's offset (257) + its
// signature length (5).
export const SIGNATURE_READ_LENGTH = 262;

/**
 * Allowed extensions with no fixed magic number — plain structured text.
 * Content is still checked, just differently: see looksLikeBinary() in
 * contentSniff.ts. A renamed binary can still claim one of these, but not
 * a renamed binary WITH ITS BYTES INTACT, which is the case that matters —
 * disguising a real executable as a "text" file.
 */
export const TEXT_LIKE_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'csv',
]);

// Sample size for the text/binary sniff — the same order of magnitude tools
// like `file` and `git`'s binary-detection use; a NUL byte this early in a
// real binary is effectively certain, and larger reads cost more for no
// practical gain on this heuristic.
export const TEXT_SNIFF_READ_LENGTH = 8 * 1024;

// Sample size for the SVG dangerous-markup scan. SVG has no magic number —
// it is XML, checked for content, not bytes (see containsDangerousSvgMarkup
// in contentSniff.ts). Matches TEXT_HEAD_BYTES in thumbnailService.ts, which
// makes the same read-prefix-not-whole-file tradeoff for the same reason.
export const SVG_SCAN_READ_LENGTH = 128 * 1024;
