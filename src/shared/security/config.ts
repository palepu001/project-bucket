// Resolves [BUG-04]: Transition from a weak blocklist to a strict ALLOWED_EXTENSIONS whitelist.
// Centralized configuration shared between frontend and backend boundaries.

export const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024; // 256 MB
export const MAX_FILENAME_LENGTH = 255;
export const INVALID_FILENAME_CHARS = /[\/\\<>"|?*\x00-\x1f]/;

export const RESERVED_FILENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Resolves [BUG-04]: Whitelist of allowed extensions.
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
  'mp4', 'mov', 'webm'
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

/**
 * Magic number signature map. Only applies to files with extensions in ALLOWED_EXTENSIONS
 * that also have known magic numbers.
 */
export const MAGIC_SIGNATURES: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  png: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  jpg: [[0xFF, 0xD8, 0xFF]],
  jpeg: [[0xFF, 0xD8, 0xFF]],
  zip: [[0x50, 0x4B, 0x03, 0x04]],
  docx: [[0x50, 0x4B, 0x03, 0x04]],
  xlsx: [[0x50, 0x4B, 0x03, 0x04]],
  pptx: [[0x50, 0x4B, 0x03, 0x04]],
  gif: [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  bmp: [[0x42, 0x4D]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
  doc: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]],
  xls: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]],
  ppt: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]],
  odt: [[0x50, 0x4B, 0x03, 0x04]],
  ods: [[0x50, 0x4B, 0x03, 0x04]],
  odp: [[0x50, 0x4B, 0x03, 0x04]],
  gz: [[0x1F, 0x8B]],
  tgz: [[0x1F, 0x8B]],
  rar: [[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]],
  '7z': [[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]],
  bz2: [[0x42, 0x5A, 0x68]],
  mp3: [[0x49, 0x44, 0x33], [0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xFA], [0xFF, 0xF2]],
  wav: [[0x52, 0x49, 0x46, 0x46]],
  ogg: [[0x4F, 0x67, 0x67, 0x53]],
  tiff: [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  tif: [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  webm: [[0x1A, 0x45, 0xDF, 0xA3]],
};

export const SIGNATURE_READ_LENGTH = 8;
