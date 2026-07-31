import { UploadItemProgress } from '../services/uploadService';
import { formatBytes } from '../utils/format';

// The optimistic placeholder shown for a file that is still uploading. Renders
// as a card in grid view and a row in list view so an in-flight upload sits
// naturally among the real attachments, exactly where its finished card/row
// will land. Progress-bar-only by design — this is the one place the panel
// shows transfer progress (downloads rely on the browser's own UI).

function phaseLabel(item: UploadItemProgress): string {
  switch (item.phase) {
    case 'pending':
      return 'Preparing…';
    case 'uploading': {
      const pct = item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0;
      return `Uploading… ${pct}%`;
    }
    case 'saving':
      return 'Saving…';
    case 'done':
      return 'Done';
    case 'failed':
      return item.error ? `Failed — ${item.error}` : 'Failed';
  }
}

function percent(item: UploadItemProgress): number {
  if (item.phase === 'saving' || item.phase === 'done') return 100;
  if (item.phase === 'failed') return 0;
  if (item.size <= 0) return item.phase === 'uploading' ? 100 : 0;
  return Math.min(100, Math.round((item.loaded / item.size) * 100));
}

function Bar({ item }: { item: UploadItemProgress }) {
  const failed = item.phase === 'failed';
  // An indeterminate bar while 'pending' (no byte count yet); a real fill once
  // bytes are moving.
  const indeterminate = item.phase === 'pending';
  return (
    <div className={`pb-progress ${failed ? 'pb-progress-failed' : ''}`}>
      <div
        className={`pb-progress-fill ${indeterminate ? 'pb-progress-indeterminate' : ''}`}
        style={indeterminate ? undefined : { width: `${percent(item)}%` }}
      />
    </div>
  );
}

export function UploadProgressCard({ item }: { item: UploadItemProgress }) {
  return (
    <div className={`pb-card pb-card-uploading ${item.phase === 'failed' ? 'pb-card-failed' : ''}`} title={item.filename}>
      <div className="pb-card-preview pb-card-preview-uploading">
        <div className="pb-upload-meta">
          <Bar item={item} />
          <span className="pb-upload-status">{phaseLabel(item)}</span>
        </div>
      </div>
      <div className="pb-card-footer">
        <span className="pb-card-name" title={item.filename}>{item.filename}</span>
        <span className="pb-card-date">{formatBytes(item.size)}</span>
      </div>
    </div>
  );
}

export function UploadProgressRow({ item }: { item: UploadItemProgress }) {
  return (
    <div className={`pb-row pb-row-uploading ${item.phase === 'failed' ? 'pb-row-failed' : ''}`} title={item.filename}>
      <div className="pb-row-name">
        <span className="pb-row-filename">{item.filename}</span>
      </div>
      <div className="pb-row-size">{formatBytes(item.size)}</div>
      <div className="pb-row-upload">
        <Bar item={item} />
        <span className="pb-upload-status">{phaseLabel(item)}</span>
      </div>
    </div>
  );
}
