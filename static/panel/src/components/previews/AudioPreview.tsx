// Same direct-URL approach as VideoPreview — see the note there for why the
// previous base64/blob: proxy was both unnecessary and the actual cause of
// playback being blocked.
//
// `waveform` is the rendition generated for this track (see thumbnailService).
// Audio is the one category with nothing to look at, so the waveform is what
// gives it a visual identity here and in the gallery grid — same image, no
// second download.
export function AudioPreview({
  url,
  mimeType,
  waveform,
}: {
  url: string;
  mimeType: string;
  waveform?: string;
}) {
  return (
    <div className="pb-audio-preview">
      {waveform && <img className="pb-audio-waveform" src={waveform} alt="" />}
      <audio controls preload="metadata">
        <source src={url} type={mimeType} />
        Your browser cannot play this audio format. Use Download instead.
      </audio>
    </div>
  );
}
