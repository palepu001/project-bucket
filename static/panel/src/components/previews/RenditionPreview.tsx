import { ImagePreview } from './ImagePreview';

// Shows the preview image Project Bucket generated for a file, for the
// categories the browser cannot display directly.
//
// The rendition is not a decoration — for these formats it IS the preview, and
// it is real content rather than a stylised placeholder: page 1 of a PDF, the
// page image embedded in an Office document (or its opening text where the
// producer stored none), the member listing of an archive, the waveform of an
// audio track. See services/thumbnailService.ts for how each is produced.
//
// `caption` says which of those the user is looking at, so nobody mistakes a
// first page for the whole document.
export function RenditionPreview({
  url,
  alt,
  caption,
}: {
  url: string;
  alt: string;
  caption: string;
}) {
  return (
    <div className="pb-rendition-preview">
      <ImagePreview url={url} alt={alt} />
      <p className="pb-state-detail">{caption}</p>
    </div>
  );
}
