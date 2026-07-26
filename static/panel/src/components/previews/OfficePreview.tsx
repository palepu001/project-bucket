import { Attachment, classifyExtension } from '../../types';
import { FileIcon } from '../FileIcon';
import { formatBytes, formatDate } from '../../utils/format';

// Forge Custom UI has no in-platform Office document renderer, and browsers
// do not render doc/docx/ppt/pptx/xls/xlsx/odt/ods/odp natively either — so
// per the spec, this is the honest fallback: real metadata, a real file
// icon, Download, and an "Open" action that lets the browser/OS decide what
// to do with the file, instead of faking a document preview that doesn't
// exist.
export function OfficePreview({
  attachment,
  url,
  onDownload,
}: {
  attachment: Attachment;
  url: string;
  onDownload: () => void;
})  {
  return (
    <div className="pb-office-preview">
      <FileIcon category={classifyExtension(attachment.extension)} extension={attachment.extension} />
      <h4>{attachment.filename}</h4>
      <p className="pb-state-detail">
        Preview isn't available for {attachment.extension.toUpperCase()} files — Forge cannot render Office documents,
        and browsers don't either. Download to open it in the associated application.
      </p>
      <dl className="pb-office-preview-meta">
        <dt>Size</dt>
        <dd>{formatBytes(attachment.size)}</dd>
        <dt>Uploaded</dt>
        <dd>{formatDate(attachment.uploadedAt)}</dd>
      </dl>
      <div className="pb-modal-actions">
        <a className="pb-button pb-button-subtle" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
        <button className="pb-button pb-button-primary" onClick={onDownload}>
          Download
        </button>
      </div>
    </div>
  );
}
