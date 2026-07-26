// Plays the stored file directly from the URL the storage contract hands us.
//
// This used to proxy the whole file through a resolver as base64 and rebuild it
// as a blob: URL, on the assumption that a cross-origin media-src was blocked.
// That was backwards: real https URLs are already allowed (manifest
// permissions.external.media), while blob: in media-src cannot be granted at
// all — permissions.content accepts only `styles` and `scripts`. So the proxy
// was the thing breaking playback, and it also imposed the content proxy's
// 10 MB cap on every video. Streaming the URL directly removes both, and lets
// the browser range-request instead of buffering the whole file first.
export function VideoPreview({ url, mimeType, poster }: { url: string; mimeType: string; poster?: string }) {
  return (
    <video className="pb-video-preview" controls preload="metadata" poster={poster}>
      <source src={url} type={mimeType} />
      Your browser cannot play this video format. Use Download instead.
    </video>
  );
}
