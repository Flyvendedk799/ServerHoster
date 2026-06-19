import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

type Side = "top" | "bottom" | "left" | "right";

const GAP = 8; // px between the trigger and the bubble
const MARGIN = 8; // keep the bubble at least this far from the viewport edge

function opposite(side: Side): Side {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

/**
 * A small "(i)" helper icon that reveals an explanatory tooltip on hover, focus,
 * or tap. Unlike the CSS `data-tooltip` system it is portal-positioned (never
 * clipped by scroll containers or card overflow), flips to stay on-screen, and
 * accepts rich content (a bold title plus `<code>`/`<p>` body). Use it next to
 * labels and headings to explain a concept; keep `data-tooltip` for terse
 * action-button hints.
 */
export function InfoHint({
  children,
  title,
  side = "top",
  size = 13,
  className = "",
  label = "More information"
}: {
  children: ReactNode;
  title?: string;
  side?: Side;
  size?: number;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const describedById = useId();

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const t = trigger.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const fits = (place: Side): boolean => {
      if (place === "top") return t.top - GAP - b.height >= MARGIN;
      if (place === "bottom") return t.bottom + GAP + b.height <= vh - MARGIN;
      if (place === "left") return t.left - GAP - b.width >= MARGIN;
      return t.right + GAP + b.width <= vw - MARGIN;
    };

    const order: Side[] = [side, opposite(side), "top", "bottom", "right", "left"];
    const place = order.find(fits) ?? side;

    let top: number;
    let left: number;
    if (place === "top") {
      top = t.top - GAP - b.height;
      left = t.left + t.width / 2 - b.width / 2;
    } else if (place === "bottom") {
      top = t.bottom + GAP;
      left = t.left + t.width / 2 - b.width / 2;
    } else if (place === "left") {
      left = t.left - GAP - b.width;
      top = t.top + t.height / 2 - b.height / 2;
    } else {
      left = t.right + GAP;
      top = t.top + t.height / 2 - b.height / 2;
    }

    left = Math.max(MARGIN, Math.min(left, vw - b.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - b.height - MARGIN));
    setCoords({ top, left });
  }, [side]);

  // Measure + place after the bubble mounts, and track scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  // Escape to dismiss; outside-tap to dismiss the click-opened state on touch.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDocPointer = (e: PointerEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDocPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDocPointer);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`info-hint ${className}`.trim()}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? describedById : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // Don't let the icon trigger an enclosing clickable card/row.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Info size={size} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={describedById}
            role="tooltip"
            className="info-hint-bubble"
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              opacity: coords ? 1 : 0
            }}
          >
            {title ? <span className="info-hint-title">{title}</span> : null}
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
