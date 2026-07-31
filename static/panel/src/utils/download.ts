/**
 * Starts a browser download for a URL minted by the storage location.
 *
 * What actually makes the file save under the right name is the
 * Content-Disposition header the storage location sets — request the URL with
 * disposition 'attachment' (see api/resolvers.getDownloadUrl). The `download`
 * attribute below is kept only as a same-origin fallback: the HTML spec has
 * browsers IGNORE it for cross-origin URLs, and a presigned storage URL is
 * always cross-origin to this iframe, so relying on it alone meant the click
 * navigated instead of saving.
 *
 * `target="_blank"` keeps that navigation out of the panel iframe. With
 * Content-Disposition present the new context downloads and closes immediately
 * rather than rendering; without it, a preview at least opens in its own tab
 * instead of replacing the panel.
 */
export function triggerBrowserDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Downloads a same-origin `blob:` URL — used by "Download all", whose ZIP is
 * assembled in the browser rather than fetched from storage.
 *
 * Unlike triggerBrowserDownload above, this does NOT set target="_blank": a
 * blob: URL is same-origin to this iframe, so the `download` attribute is
 * honoured and the click saves the file directly. Opening a new tab would just
 * flash an empty context. The caller owns revoking the object URL afterwards.
 */
export function triggerBlobDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
