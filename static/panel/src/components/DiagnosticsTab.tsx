import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/resolvers';
import { MigrationRun, MigrationRunStatus, MigrationItem } from '../types';
import { StorageAuditItem } from '../api/resolvers';

import { formatBytes, formatDate, formatDuration } from '../utils/format';
import { LoadingState, ErrorState } from './States';

const STATUS_LABEL: Record<MigrationRunStatus, string> = {
  RUNNING: 'In progress',
  COMPLETED: 'Completed',
  PARTIAL_FAILURE: 'Native copies not removed',
  FAILED: 'Failed — nothing migrated',
};

// A run is retryable when it is terminal but not fully done: FAILED (aborted,
// retry re-runs the whole session) or PARTIAL_FAILURE (retry re-attempts only
// the native deletions).
function isRetryable(status: MigrationRunStatus): boolean {
  return status === 'FAILED' || status === 'PARTIAL_FAILURE';
}

function itemGlyph(status: string): string {
  if (status === 'SUCCEEDED') return '✓';
  if (status === 'FAILED') return '✗';
  if (status === 'SOURCE_DELETE_FAILED') return '⚠';
  if (status === 'SOURCE_MISSING') return '–';
  // Blocked is not a failure of the run — the file was simply not eligible and
  // stayed in Jira — so it gets its own mark rather than a cross.
  if (status === 'BLOCKED') return '⊘';
  return '…';
}

export function DiagnosticsTab({ issueId }: { issueId: string })  {
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [storageAudit, setStorageAudit] = useState<StorageAuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageAuditError, setStorageAuditError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // Filenames whose native Jira source vanished, discovered by the last retry.
  // Terminal information — rendered as a centered OK-only dialog, since there
  // is nothing left to retry for those files.
  const [missingFiles, setMissingFiles] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStorageAuditError(null);
    try {
      // Keep migration history and the storage audit independent. A historical
      // migration query should not hide live object-store evidence, and vice
      // versa, while we investigate an attachment problem.
      const [migrationResult, auditResult] = await Promise.allSettled([
        api.getMigrationDiagnostics(issueId),
        api.getStorageAudit(issueId),
      ]);

      if (migrationResult.status === 'fulfilled') {
        setRuns(migrationResult.value);
      } else {
        setError(migrationResult.reason instanceof Error ? migrationResult.reason.message : String(migrationResult.reason));
      }

      if (auditResult.status === 'fulfilled') {
        setStorageAudit(auditResult.value);
      } else {
        setStorageAuditError(auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRetry(run: MigrationRun) {
    setRetryingId(run.id);
    try {
      // retryMigrationAsync resets items, re-opens the run, and enqueues the
      // 900-second async worker. We poll getMigrationRunStatus for the result.
      const queued = await api.retryMigrationAsync(run.id);

      const POLL_INTERVAL_MS = 3000;
      const MAX_POLLS = 200; // 10 minutes max
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const status = await api.getMigrationRunStatus(queued.runId);
        if (!status) break;
        if (status.status === 'COMPLETED' || status.status === 'FAILED' || status.status === 'PARTIAL_FAILURE') {
          const missing = status.items
            .filter((item: MigrationItem) => item.status === 'SOURCE_MISSING')
            .map((item: MigrationItem) => item.filename);
          if (missing.length > 0) setMissingFiles(missing);
          break;
        }
      }
    } finally {
      setRetryingId(null);
      refresh();
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  return (
    <div className="pb-diagnostics">
      <section className="pb-storage-audit">
        <div className="pb-storage-audit-heading">
          <div>
            <h3>Storage audit</h3>
            <p className="pb-state-detail">
              Every active Project Bucket key for this issue, checked live against storage backend. Forge does not provide a bucket-wide list.
            </p>
          </div>
          <button className="pb-button pb-button-subtle" onClick={refresh}>
            Refresh audit
          </button>
        </div>
        {storageAuditError && <p className="pb-storage-audit-error">Could not read storage status: {storageAuditError}</p>}
        {!storageAuditError && storageAudit.length === 0 && (
          <p className="pb-state-detail">No active Project Bucket files are recorded for this issue.</p>
        )}
        {storageAudit.length > 0 && (
          <div className="pb-storage-audit-table-wrap">
            <table className="pb-storage-audit-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Attachment location</th>
                  <th>Storage status</th>
                  <th>Size</th>
                  <th>Checksum</th>
                </tr>
              </thead>
              <tbody>
                {storageAudit.map((item) => (
                  <tr key={item.attachmentId}>
                    <td>
                      <strong>{item.filename}</strong>
                      <span className="pb-storage-audit-source">{item.source === 'PROJECT_BUCKET_UPLOAD' ? 'Project Bucket upload' : 'Jira migration'}</span>
                    </td>
                    <td><code>{item.objectKey}</code></td>
                    <td>
                      <span className={`pb-storage-audit-status ${item.metadataMatches ? 'pb-storage-audit-status-ok' : 'pb-storage-audit-status-error'}`}>
                        {item.metadataMatches ? 'Present and verified' : item.exists ? 'Metadata mismatch' : 'Missing'}
                      </span>
                    </td>
                    <td>{item.exists ? `${formatBytes(item.storedSize ?? 0)} stored / ${formatBytes(item.expectedSize)} expected` : `${formatBytes(item.expectedSize)} expected`}</td>
                    <td>{item.exists ? (item.metadataMatches ? 'Matches' : 'Does not match') : 'Not available'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {runs.length === 0 && (
        <div className="pb-state">
          <p>No migrations yet.</p>
          <p className="pb-state-detail">
            When native Jira attachments are detected on this issue, linking them to Project Bucket will show up here.
          </p>
        </div>
      )}
      {missingFiles && (
        <div className="pb-modal-overlay">
          <div className="pb-modal pb-modal-small">
            <div className="pb-modal-header">
              <h3>{missingFiles.length === 1 ? 'Attachment missing in Jira' : 'Attachments missing in Jira'}</h3>
            </div>
            <p style={{ margin: '0 0 8px' }}>
              {missingFiles.length === 1
                ? 'This attachment is missing in Jira, so it was not moved to Project Bucket. Please recheck its availability:'
                : 'These attachments are missing in Jira, so they were not moved to Project Bucket. Please recheck their availability:'}
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
              {missingFiles.map((filename) => (
                <li key={filename} style={{ fontWeight: 600, wordBreak: 'break-all' }}>
                  {filename}
                </li>
              ))}
            </ul>
            <p className="pb-state-detail" style={{ margin: 0 }}>
              All other detected attachments were linked. There is nothing left to retry for the files above.
            </p>
            <div className="pb-modal-actions">
              <button className="pb-button pb-button-primary" onClick={() => setMissingFiles(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {runs.map((run) => (
        <div key={run.id} className="pb-migration-run">
          <div className="pb-migration-run-header">
            <div>
              <strong>Migration</strong> <span className="pb-state-detail">{run.id.slice(0, 8)}</span>
            </div>
            <span className={`pb-status-pill pb-status-${run.status.toLowerCase()}`}>{STATUS_LABEL[run.status]}</span>
          </div>
          <div className="pb-migration-run-counts">
            <span>Detected {run.requestedCount}</span>
            <span>Migrated {run.migratedCount}</span>
            <span>Failed {run.failedCount}</span>
            <span>Duration {formatDuration(run.startedAt, run.completedAt)}</span>
          </div>
          <div className="pb-migration-run-times pb-state-detail">
            Started {formatDate(run.startedAt)}
            {run.completedAt ? ` · Completed ${formatDate(run.completedAt)}` : ' · Still running'}
          </div>
          <ul className="pb-migration-file-list">
            {run.items.map((item) => (
              <li key={item.id} className={item.status === 'FAILED' ? 'pb-file-failed' : 'pb-file-ok'}>
                <span aria-hidden="true">{itemGlyph(item.status)}</span>
                <span>{item.filename}</span>
                {item.errorMessage &&
                  (item.status === 'FAILED' ||
                    item.status === 'SOURCE_DELETE_FAILED' ||
                    item.status === 'SOURCE_MISSING' ||
                    item.status === 'BLOCKED') && (
                  <span className="pb-state-detail"> — {item.errorMessage}</span>
                )}
              </li>
            ))}
          </ul>
          {isRetryable(run.status) && (
            <button className="pb-button pb-button-subtle" disabled={retryingId === run.id} onClick={() => handleRetry(run)}>
              {retryingId === run.id
                ? 'Retrying…'
                : run.status === 'PARTIAL_FAILURE'
                  ? 'Retry removing native copies'
                  : 'Retry migration'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
