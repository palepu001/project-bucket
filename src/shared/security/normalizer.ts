// Resolves [BUG-03] and [BUG-05]: Strict file normalization.

export const FileNormalizer = {
  /**
   * Strips dangerous characters and normalizes extensions.
   * Resolves [BUG-03]: Trims trailing spaces and dots.
   * Resolves [BUG-05]: Strips RTL overrides and replaces colons.
   */
  normalizeFilename(rawName: string): string {
    if (!rawName) return '';
    
    let name = rawName;
    
    // 1. Strip trailing spaces and dots which Windows strips (bypassing filters)
    name = name.replace(/[\s.]+$/, '');
    
    // 2. Strip unicode control characters (including RTL overrides \u202E)
    // Basic control chars (\x00-\x1f) are blocked by the FilenameValidator later,
    // but we strip formatting controls here so the extension parser isn't fooled.
    name = name.replace(/[\u200E\u200F\u202A-\u202E]/g, '');
    
    // 3. Replace colons (invalid on Windows, can cause truncation or alternate data streams)
    name = name.replace(/:/g, '-');
    
    return name;
  },

  /**
   * Safely extracts the final extension after normalization.
   */
  extractExtension(normalizedName: string): string {
    const idx = normalizedName.lastIndexOf('.');
    if (idx === -1 || idx === normalizedName.length - 1) return '';
    return normalizedName.slice(idx + 1).toLowerCase();
  }
};
