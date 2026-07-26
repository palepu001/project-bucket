import { useEffect, useMemo, useState } from 'react';
import { events, showFlag, view } from '@forge/bridge';
import { useIssueContext } from './hooks/useIssueContext';
import { useAttachments } from './hooks/useAttachments';
import { useAccountNames } from './hooks/useAccountNames';
import { useThumbnails, useThumbnailBackfill } from './hooks/useThumbnails';
import { Attachment, FileCategory, classifyExtension } from './types';
import * as api from './api/resolvers';
import { UploadButton } from './components/UploadButton';
import { Toolbar } from './components/Toolbar';
import { Gallery } from './components/Gallery';
import { LoadingState, ErrorState, EmptyState } from './components/States';
import { PreviewModal } from './components/PreviewModal';
import { ConfirmDeleteDialog } from './components/ConfirmDeleteDialog';
import { DiagnosticsTab } from './components/DiagnosticsTab';
import { triggerBrowserDownload } from './utils/download';

type PanelTab = 'gallery' | 'diagnostics';

// Broadcast by static/attachment-watcher after a migration completes (kept as
// a literal in both bundles — see the cross-bundle duplication note in
// services/migrationClient.ts). The watcher runs in a background script,
// where view.refresh() is unsupported, so THIS panel owns the refresh: its
// own gallery via refetch, and the native issue view (attachment list,
// description) via view.refresh() from its refreshable issue-panel context.
const ATTACHMENTS_CHANGED_EVENT = 'project-bucket.attachments-changed';

export function App()  {
  const { context, error: contextError } = useIssueContext();
  const [tab, setTab] = useState<PanelTab>('gallery');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FileCategory | null>(null);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const { attachments, state, errorMessage, refresh } = useAttachments(context?.issueId ?? null, search);
  const uploaderNames = useAccountNames(attachments.map((a) => a.uploadedBy));
  const thumbnails = useThumbnails(attachments);
  // Renders previews for rows that never went through the upload path (migrated
  // attachments, and anything predating the feature), then refreshes so the new
  // thumbnails appear. Runs a few files per pass in the background.
  useThumbnailBackfill(attachments, refresh);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let unmounted = false;
    events
      .on(ATTACHMENTS_CHANGED_EVENT, () => {
        refresh();
        // Also re-render the host issue view so the just-deleted native
        // copies disappear from Jira's own attachment list without a manual
        // reload. Failure here is cosmetic-only, so it is swallowed.
        view.refresh().catch(() => undefined);
      })
      .then((sub) => {
        if (unmounted) sub.unsubscribe();
        else subscription = sub;
      });
    return () => {
      unmounted = true;
      subscription?.unsubscribe();
    };
  }, [refresh]);

  const filtered = useMemo(
    () => (category ? attachments.filter((a) => classifyExtension(a.extension) === category) : attachments),
    [attachments, category]
  );

  async function handleDownload(attachment: Attachment) {
    try {
      const result = await api.getDownloadUrl(attachment.id);
      // If the object is missing from storage, show a friendly message
      // instead of attempting a download that will fail.
      if (result.unavailable || !result.url) {
        showFlag({
          id: `pb-download-unavailable-${attachment.id}`,
          title: 'File unavailable',
          type: 'warning',
          description: `"${attachment.filename}" is no longer available for download. The stored data could not be found.`,
          isAutoDismiss: true,
        });
        return;
      }
      triggerBrowserDownload(result.url, result.filename);
    } catch (error) {
      showFlag({
        id: `pb-download-error-${attachment.id}`,
        title: 'Download failed',
        type: 'error',
        description: 'Something went wrong while preparing the download. Please try again.',
        isAutoDismiss: false,
      });
    }
  }

  async function handleConfirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteAttachment(deleting.id);
      setDeleting(null);
      refresh();
    } catch (error) {
      showFlag({
        id: `pb-delete-error-${deleting.id}`,
        title: 'Delete failed',
        type: 'error',
        description: error instanceof Error ? error.message : String(error),
        isAutoDismiss: false,
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  if (contextError) {
    return <ErrorState message={contextError} onRetry={() => location.reload()} />;
  }
  if (!context) {
    return <LoadingState />;
  }

  return (
    <div className="pb-app">
      {/* Jira already renders this panel's "Project Bucket" title above the
          iframe, so the panel chrome is just one row: tabs left, the single
          action right. Repeating the title here only added noise. */}
      <div className="pb-topbar">
        <div className="pb-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'gallery'} className={`pb-tab ${tab === 'gallery' ? 'pb-tab-active' : ''}`} onClick={() => setTab('gallery')}>
            Gallery
          </button>
          <button role="tab" aria-selected={tab === 'diagnostics'} className={`pb-tab ${tab === 'diagnostics' ? 'pb-tab-active' : ''}`} onClick={() => setTab('diagnostics')}>
            Diagnostics
          </button>
        </div>
        <UploadButton issueId={context.issueId} projectId={context.projectId} onUploaded={refresh} />
      </div>

      {tab === 'gallery' && (
        <>
          <Toolbar search={search} onSearchChange={setSearch} category={category} onCategoryChange={setCategory} />

          {state === 'loading' && <LoadingState />}
          {state === 'error' && <ErrorState message={errorMessage ?? 'Unknown error'} onRetry={refresh} />}
          {state === 'ready' && filtered.length === 0 && (
            <EmptyState
              hasFilters={search.length > 0 || category !== null}
              onClearFilters={() => {
                setSearch('');
                setCategory(null);
              }}
            />
          )}
          {state === 'ready' && filtered.length > 0 && (
            <Gallery
              attachments={filtered}
              uploaderNames={uploaderNames}
              thumbnails={thumbnails}
              onPreview={setPreviewing}
              onDownload={handleDownload}
              onDelete={setDeleting}
            />
          )}
        </>
      )}

      {tab === 'diagnostics' && <DiagnosticsTab issueId={context.issueId} />}

      {previewing && <PreviewModal attachment={previewing} onClose={() => setPreviewing(null)} onDownload={handleDownload} onDelete={(a) => { setPreviewing(null); setDeleting(a); }} />}
      {deleting && (
        <ConfirmDeleteDialog
          attachment={deleting}
          busy={deleteBusy}
          onCancel={() => setDeleting(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
