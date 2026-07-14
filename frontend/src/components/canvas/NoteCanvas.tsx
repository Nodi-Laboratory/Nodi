"use client";

// Controlled pan/zoom canvas — camera state is owned by the parent
// (ConceptCanvasWorkspace); every change is delegated via onCameraChange.
// Ported from Nodi-figma/components/NoteCanvas.js (createElement -> JSX/TS).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// Pointer-down on these interactive elements must NOT start a canvas pan.
const NO_PAN =
  "button, input, textarea, select, a, label, [contenteditable], [data-no-pan]";

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

const DEFAULT_CAM: Camera = { x: 0, y: 0, scale: 1 };
const safe = (c: Camera | null | undefined): Camera =>
  c && typeof c.scale === "number" ? c : DEFAULT_CAM;

// Pure: camera that centers canvas coord `target` in `viewport`.
// (Caller offsets to the card center; here it's a plain coordinate transform.)
export function focusCamera(
  viewport: { w: number; h: number },
  target: { x: number; y: number },
  scale = 1,
): Camera {
  const s = clamp(scale, MIN_SCALE, MAX_SCALE);
  return {
    x: viewport.w / 2 - target.x * s,
    y: viewport.h / 2 - target.y * s,
    scale: s,
  };
}

export default function NoteCanvas({
  camera,
  onCameraChange,
  children,
}: {
  camera: Camera;
  onCameraChange: (next: Camera) => void;
  children?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [wheeling, setWheeling] = useState(false);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Mirror latest camera/callback into refs (avoid stale closures in listeners).
  // Synced in an effect (not during render) — handlers fire post-commit anyway.
  const camRef = useRef<Camera>(safe(camera));
  const changeRef = useRef(onCameraChange);
  useEffect(() => {
    camRef.current = safe(camera);
    changeRef.current = onCameraChange;
  }, [camera, onCameraChange]);

  // rAF throttle: coalesce a frame's events into one emit.
  const pending = useRef<Camera | null>(null);
  const raf = useRef<number>(0);
  const flush = useCallback(() => {
    raf.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) {
      camRef.current = next;
      changeRef.current?.(next);
    }
  }, []);
  const emit = useCallback(
    (next: Camera) => {
      pending.current = next;
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      clearTimeout(wheelTimer.current);
    },
    [],
  );

  // Wheel: pan by default; ctrl/⌘ -> cursor-anchored zoom.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setWheeling(true);
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => setWheeling(false), 180);
      const base = pending.current || camRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = clamp(base.scale * factor, MIN_SCALE, MAX_SCALE);
        const k = scale / base.scale;
        emit({ scale, x: px - (px - base.x) * k, y: py - (py - base.y) * k });
      } else {
        emit({ scale: base.scale, x: base.x - e.deltaX, y: base.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [emit]);

  // Drag pan: compute absolute delta from the drag-start camera.
  const drag = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    s: number;
  } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest(NO_PAN)) return;
    const c = camRef.current;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, s: c.scale };
    setGrabbing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      emit({
        scale: d.s,
        x: d.ox + (e.clientX - d.sx),
        y: d.oy + (e.clientY - d.sy),
      });
    },
    [emit],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    setGrabbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const cam = safe(camera);

  return (
    <div
      ref={viewportRef}
      data-testid="note-viewport"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        touchAction: "none",
        background: "transparent",
        cursor: grabbing ? "grabbing" : "grab",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-testid="note-canvas"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: CANVAS_W,
          height: CANVAS_H,
          transformOrigin: "0 0",
          willChange: "transform",
          transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`,
          transition:
            grabbing || wheeling
              ? "none"
              : "transform 0.7s cubic-bezier(.22,.9,.24,1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
