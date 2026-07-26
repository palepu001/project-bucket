import { useRef, useState, WheelEvent, MouseEvent } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

// Real pan/zoom, not a fake static preview: mouse wheel zooms toward the
// cursor, click-and-drag pans once zoomed in. No dependency — this is a
// small enough interaction to hand-roll with a CSS transform.
export function ImagePreview({ url, alt }: { url: string; alt: string })  {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale - event.deltaY * 0.0025 * scale));
    setScale(next);
    if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
  }

  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (scale === MIN_SCALE) return;
    dragging.current = { startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y };
  }

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const dx = event.clientX - dragging.current.startX;
    const dy = event.clientY - dragging.current.startY;
    setOffset({ x: dragging.current.originX + dx, y: dragging.current.originY + dy });
  }

  function stopDragging() {
    dragging.current = null;
  }

  function resetZoom() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  return (
    <div className="pb-image-preview">
      <div className="pb-image-preview-toolbar">
        <button className="pb-button pb-button-subtle" onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.5))}>
          Zoom in
        </button>
        <button className="pb-button pb-button-subtle" onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.5))}>
          Zoom out
        </button>
        <button className="pb-button pb-button-subtle" onClick={resetZoom}>
          Reset
        </button>
        <span className="pb-image-preview-scale">{Math.round(scale * 100)}%</span>
      </div>
      <div
        className="pb-image-preview-viewport"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
        style={{ cursor: scale > MIN_SCALE ? 'grab' : 'default' }}
      >
        <img
          src={url}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
    </div>
  );
}
