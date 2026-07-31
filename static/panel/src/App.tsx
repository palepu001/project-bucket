import { useEffect, useMemo, useState } from 'react';
import { events, showFlag, view } from '@forge/bridge';
import { useIssueContext } from './hooks/useIssueContext';
import { useAttachments } from './hooks/useAttachments';
import { useAccountNames } from './hooks/useAccountNames';
import { useThumbnails, useThumbnailBackfill } from './hooks/useThumbnails';
import { Attachment, FileCategory, classifyExtension } from './types';
import * as api from './api/resolvers';
import { UploadButton } from './components/UploadButton';
import { Toolbar, ViewMode } from './components/Toolbar';
import { Gallery } from './components/Gallery';
import { LoadingState, ErrorState, EmptyState } from './components/States';
import { PreviewModal } from './components/PreviewModal';
import { ConfirmDeleteDialog } from './components/ConfirmDeleteDialog';
import { BulkDeleteDialog } from './components/BulkDeleteDialog';
import { DiagnosticsTab } from './components/DiagnosticsTab';
import { triggerBrowserDownload } from './utils/download';
import { uploadFiles, UploadItemProgress } from './services/uploadService';
import { downloadAllAsZip } from './services/bulkDownload';
import { runWithConcurrency } from './utils/concurrency';

type PanelTab = 'gallery' | 'diagnostics';

// Persists the grid/list choice across panel reloads. Kept in localStorage
// rather than backend state — it is a per-user viewing preference, not issue
// data — and guarded because a sandboxed iframe can have storage disabled.
const VIEW_MODE_KEY = 'pb-view-mode';

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

// How many per-file deletes "Delete all" runs at once. Matches the bulk-download
// width — enough to feel prompt on a large issue without hammering the resolver.
const BULK_DELETE_CONCURRENCY = 4;

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
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // In-progress direct uploads, surfaced as optimistic placeholders in the
  // gallery (see uploadService / UploadProgressItem).
  const [uploads, setUploads] = useState<UploadItemProgress[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);

  // Whole-issue bulk actions from the "⋯" menu.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteItems, setBulkDeleteItems] = useState<Attachment[] | null>(null);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState(0);

  const { attachments, state, errorMessage, refresh } = useAttachments(context?.issueId ?? null, search);
  const uploaderNames = useAccountNames(attachments.map((a) => a.uploadedBy));
  const thumbnails = useThumbnails(attachments);
  // Renders previews for rows that never went through the upload path (migrated
  // attachments, and anything predating the feature), then refreshes so the new
  // thumbnails appear. Silent so the background pass never flashes the gallery.
  useThumbnailBackfill(attachments, () => refresh({ silent: true }));

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let unmounted = false;
    events
      .on(ATTACHMENTS_CHANGED_EVENT, () => {
        refresh({ silent: true });
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

  function changeViewMode(next: ViewMode) {
    setViewMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // Storage disabled — the choice simply won't persist across reloads.
    }
  }

  async function handleUpload(files: File[]) {
    if (!context || files.length === 0) return;
    setUploadBusy(true);
    try {
      const { created, failed } = await uploadFiles(files, context.issueId, context.projectId, setUploads);
      if (failed.length > 0) {
        showFlag({
          id: `pb-upload-failed-${Date.now()}`,
          title: failed.length === 1 ? 'A file failed to upload' : `${failed.length} files failed to upload`,
          type: 'error',
          description: failed.map((f) => `${f.filename}: ${f.error}`).join('; '),
          isAutoDismiss: false,
        });
      } else if (created.length > 0) {
        showFlag({
          id: `pb-upload-success-${Date.now()}`,
          title: created.length === 1 ? 'Attachment added' : `${created.length} attachments added`,
          type: 'success',
          description: 'Uploaded to Project Bucket.',
          isAutoDismiss: true,
        });
      }
      if (created.length > 0) {
        // Drop the placeholders first, then pull in the real rows — a brief gap
        // reads cleaner than a placeholder and its finished card overlapping.
        setUploads([]);
        await refresh({ silent: true });
      }
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('<!DOCTYPE html>') || errorMessage.includes('<html')) {
        errorMessage =
          'A network or proxy error occurred while communicating with the server. If you are using forge tunnel, this may be an issue with tunnel connectivity.';
      }
      showFlag({
        id: `pb-upload-error-${Date.now()}`,
        title: 'Upload failed',
        type: 'error',
        description: errorMessage,
        isAutoDismiss: false,
      });
    } finally {
      setUploads([]);
      setUploadBusy(false);
    }
  }

  async function handleDownload(attachment: Attachment) {
    try {
      // 'attachment' makes the storage location return a Content-Disposition
      // that saves the file under its real name — the `<a download>` hint alone
      // does nothing for a cross-origin URL.
      const result = await api.getDownloadUrl(attachment.id, 'attachment');
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

  // "Download all" — always the whole issue, never the current filter, so the
  // definitive list is fetched fresh here rather than reusing `filtered`.
  async function handleDownloadAll() {
    if (!context) return;
    setBulkBusy(true);
    const preparing = await showFlag({
      id: `pb-zip-${Date.now()}`,
      title: 'Preparing download…',
      type: 'info',
      description: 'Bundling this issue’s attachments into a single ZIP.',
      isAutoDismiss: false,
    });
    try {
      const all = await api.listAttachments({ issueId: context.issueId });
      if (all.length === 0) {
        preparing.close();
        return;
      }
      const { zipped, failed } = await downloadAllAsZip(all, 'project-bucket-attachments.zip');
      preparing.close();
      if (zipped === 0) {
        showFlag({
          id: `pb-zip-failed-${Date.now()}`,
          title: 'Download failed',
          type: 'error',
          description: 'None of the attachments could be retrieved from storage.',
          isAutoDismiss: false,
        });
      } else {
        showFlag({
          id: `pb-zip-done-${Date.now()}`,
          title: `Downloaded ${zipped} ${zipped === 1 ? 'file' : 'files'}`,
          type: failed.length > 0 ? 'warning' : 'success',
          description:
            failed.length > 0
              ? `${failed.length} file(s) could not be included: ${failed.map((f) => f.filename).join(', ')}.`
              : 'Your ZIP is downloading.',
          isAutoDismiss: failed.length === 0,
        });
      }
    } catch (error) {
      preparing.close();
      showFlag({
        id: `pb-zip-error-${Date.now()}`,
        title: 'Download failed',
        type: 'error',
        description: error instanceof Error ? error.message : String(error),
        isAutoDismiss: false,
      });
    } finally {
      setBulkBusy(false);
    }
  }

  // "Delete all" — fetch the whole-issue list, then open the confirm dialog
  // with that exact set so the count and the action can never disagree with a
  // filter that happens to be active.
  async function handleRequestDeleteAll() {
    if (!context) return;
    setBulkBusy(true);
    try {
      const all = await api.listAttachments({ issueId: context.issueId });
      if (all.length === 0) return;
      setBulkDeleteItems(all);
    } catch (error) {
      showFlag({
        id: `pb-bulk-delete-load-error-${Date.now()}`,
        title: 'Could not start bulk delete',
        type: 'error',
        description: error instanceof Error ? error.message : String(error),
        isAutoDismiss: false,
      });
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleConfirmDeleteAll() {
    if (!bulkDeleteItems) return;
    setBulkDeleteBusy(true);
    setBulkDeleteProgress(0);
    let completed = 0;
    const failures: string[] = [];
    await runWithConcurrency(bulkDeleteItems, BULK_DELETE_CONCURRENCY, async (attachment) => {
      try {
        await api.deleteAttachment(attachment.id);
      } catch {
        failures.push(attachment.filename);
      } finally {
        completed += 1;
        setBulkDeleteProgress(completed);
      }
    });
    setBulkDeleteItems(null);
    setBulkDeleteBusy(false);
    await refresh({ silent: true });
    if (failures.length > 0) {
      showFlag({
        id: `pb-bulk-delete-partial-${Date.now()}`,
        title: `${failures.length} of ${completed} could not be deleted`,
        type: 'warning',
        description: failures.join(', '),
        isAutoDismiss: false,
      });
    } else {
      showFlag({
        id: `pb-bulk-delete-done-${Date.now()}`,
        title: `Deleted ${completed} ${completed === 1 ? 'attachment' : 'attachments'}`,
        type: 'success',
        description: 'Removed from Project Bucket.',
        isAutoDismiss: true,
      });
    }
  }

  async function handleConfirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteAttachment(deleting.id);
      setDeleting(null);
      refresh({ silent: true });
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

  const hasContent = filtered.length > 0 || uploads.length > 0;

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
        <UploadButton onFiles={handleUpload} busy={uploadBusy} />
      </div>

      {tab === 'gallery' && (
        <>
          <Toolbar
            search={search}
            onSearchChange={setSearch}
            category={category}
            onCategoryChange={setCategory}
            viewMode={viewMode}
            onViewModeChange={changeViewMode}
            attachmentCount={attachments.length}
            bulkBusy={bulkBusy}
            onDownloadAll={handleDownloadAll}
            onDeleteAll={handleRequestDeleteAll}
          />

          {state === 'loading' && <LoadingState />}
          {state === 'error' && <ErrorState message={errorMessage ?? 'Unknown error'} onRetry={refresh} />}
          {state === 'ready' && !hasContent && (
            <EmptyState
              hasFilters={search.length > 0 || category !== null}
              onClearFilters={() => {
                setSearch('');
                setCategory(null);
              }}
            />
          )}
          {state === 'ready' && hasContent && (
            <Gallery
              attachments={filtered}
              uploaderNames={uploaderNames}
              thumbnails={thumbnails}
              viewMode={viewMode}
              uploads={uploads}
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
      {bulkDeleteItems && (
        <BulkDeleteDialog
          count={bulkDeleteItems.length}
          busy={bulkDeleteBusy}
          progress={bulkDeleteProgress}
          onCancel={() => setBulkDeleteItems(null)}
          onConfirm={handleConfirmDeleteAll}
        />
      )}
    </div>
  );
}
