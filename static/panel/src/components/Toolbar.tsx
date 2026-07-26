import { FileCategory } from '../types';

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
}: {
  search: string;
  onSearchChange: (value: string) => void;
  category: FileCategory | null;
  onCategoryChange: (value: FileCategory | null) => void;
})  {
  return (
    <div className="pb-toolbar">
      <input
        className="pb-search"
        type="search"
        placeholder="Search by filename or extension…"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        aria-label="Search attachments"
      />
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
