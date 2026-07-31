import { useEffect, useRef, useState } from 'react';
import { FileCategory } from '../types';

export type ViewMode = 'grid' | 'list';

const CATEGORY_LABELS: { category: FileCategory; label: string }[] = [
  { category: 'IMAGES', label: 'Images' },
  { category: 'DOCUMENTS', label: 'Documents' },
  { category: 'PDF', label: 'PDF' },
  { category: 'OFFICE', label: 'Office' },
  { category: 'VIDEOS', label: 'Videos' },
  { category: 'AUDIO', label: 'Audio' },
  { category: 'ARCHIVES', label: 'Archives' },
  { category: 'OTHER', label: 'Other' },
];

export function Toolbar({
  search,
  onSearchChange,
  category,
  onCategoryChange,
  viewMode,
  onViewModeChange,
  attachmentCount,
  bulkBusy,
  onDownloadAll,
  onDeleteAll,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  category: FileCategory | null;
  onCategoryChange: (value: FileCategory | null) => void;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  // Whole-issue attachment count, shown against "Download all" the way Jira's
  // own kebab does. Also gates the menu: with nothing to act on, it is hidden.
  attachmentCount: number;
  bulkBusy: boolean;
  onDownloadAll: () => void;
  onDeleteAll: () => void;
})  {
  return (
    <div className="pb-toolbar">
      <div className="pb-toolbar-row">
        <input
          className="pb-search"
          type="search"
          placeholder="Search by filename or extension…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label="Search attachments"
        />
        <OverflowMenu
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          attachmentCount={attachmentCount}
          bulkBusy={bulkBusy}
          onDownloadAll={onDownloadAll}
          onDeleteAll={onDeleteAll}
        />
      </div>
      <div className="pb-filters" role="group" aria-label="Filter by file type">
        <button
          className={`pb-chip ${category === null ? 'pb-chip-active' : ''}`}
          onClick={() => onCategoryChange(null)}
        >
          All
        </button>
        {CATEGORY_LABELS.map(({ category: c, label }) => (
          <button
            key={c}
            className={`pb-chip ${category === c ? 'pb-chip-active' : ''}`}
            onClick={() => onCategoryChange(category === c ? null : c)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// The "⋯" kebab, modelled on Jira's native Attachments menu: switch view,
// download all (with the issue's count), delete all. Closes on outside click or
// Escape.
function OverflowMenu({
  viewMode,
  onViewModeChange,
  attachmentCount,
  bulkBusy,
  onDownloadAll,
  onDeleteAll,
}: {
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  attachmentCount: number;
  bulkBusy: boolean;
  onDownloadAll: () => void;
  onDeleteAll: () => void;
})  {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const hasFiles = attachmentCount > 0;

  return (
    <div className="pb-menu" ref={rootRef}>
      <button
        className="pb-icon-button pb-menu-trigger"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="4" cy="9" r="1.4" fill="currentColor" />
          <circle cx="9" cy="9" r="1.4" fill="currentColor" />
          <circle cx="14" cy="9" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="pb-menu-list" role="menu">
          <button
            role="menuitem"
            className="pb-menu-item"
            onClick={() => {
              onViewModeChange(viewMode === 'grid' ? 'list' : 'grid');
              setOpen(false);
            }}
          >
            {viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          </button>
          <button
            role="menuitem"
            className="pb-menu-item"
            disabled={!hasFiles || bulkBusy}
            onClick={() => {
              setOpen(false);
              onDownloadAll();
            }}
          >
            <span>Download all</span>
            {hasFiles && <span className="pb-menu-count">{attachmentCount}</span>}
          </button>
          <button
            role="menuitem"
            className="pb-menu-item pb-menu-item-danger"
            disabled={!hasFiles || bulkBusy}
            onClick={() => {
              setOpen(false);
              onDeleteAll();
            }}
          >
            Delete all
          </button>
        </div>
      )}
    </div>
  );
}
