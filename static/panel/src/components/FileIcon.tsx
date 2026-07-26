import { FileCategory } from '../types';

// A generic "document with a folded corner" glyph, tinted per category, with
// the extension printed across it. No icon font or SVG-sprite dependency —
// every previewable/filterable category enumerated in the spec gets a
// distinct, real (not placeholder) icon color so the gallery is scannable
// at a glance.
const CATEGORY_COLORS: Record<FileCategory, string> = {
  IMAGES: '#00875A',
  DOCUMENTS: '#0052CC',
  PDF: '#DE350B',
  OFFICE: '#0065FF',
  VIDEOS: '#6554C0',
  AUDIO: '#FF8B00',
  ARCHIVES: '#5E6C84',
  OTHER: '#8993A4',
};

export function FileIcon({ category, extension }: { category: FileCategory; extension: string })  {
  const color = CATEGORY_COLORS[category];
  const label = extension ? extension.slice(0, 4).toUpperCase() : '?';

  return (
    <svg width="40" height="48" viewBox="0 0 40 48" aria-hidden="true">
      <path
        d="M4 2 H24 L36 14 V44 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 V4 a2 2 0 0 1 2 -2 Z"
        fill={color}
        fillOpacity="0.12"
        stroke={color}
        strokeWidth="1.5"
      />
      <path d="M24 2 V12 a2 2 0 0 0 2 2 H36" fill="none" stroke={color} strokeWidth="1.5" />
      <text x="20" y="33" textAnchor="middle" fontSize="9" fontWeight="700" fill={color} fontFamily="sans-serif">
        {label}
      </text>
    </svg>
  );
}
