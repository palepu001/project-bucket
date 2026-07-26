// Same direct-URL approach as VideoPreview — see the note there for why the
// previous base64/blob: proxy was both unnecessary and the actual cause of
// playback being blocked.
export function AudioPreview({ url, mimeType }: { url: string; mimeType: string }) {
  return (
    <div className="pb-audio-preview">
      <audio controls preload="metadata">
        <source src={url} type={mimeType} />
        Your browser cannot play this audio format. Use Download instead.
      </audio>
    </div>
  );
}
