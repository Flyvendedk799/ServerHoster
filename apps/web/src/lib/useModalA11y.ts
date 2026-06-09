import { useEffect, type RefObject } from "react";

type Options = {
  /** Called on Escape and (if you wire it) overlay click. */
  onClose?: () => void;
  /**
   * Called on Enter when focus is NOT in a textarea/button/select. Wire this to
   * the modal's primary action so a form can be submitted from the keyboard.
   */
  onSubmit?: () => void;
  /** Skip moving focus into the dialog on mount (rarely needed). */
  noAutoFocus?: boolean;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Give a modal/dialog the keyboard + focus behaviour users expect, without
 * restructuring its markup: Escape closes, Enter submits (outside textareas),
 * Tab is trapped inside the dialog, and focus moves to the first field on open.
 * Attach the returned ref's element via `ref={ref}` on the `.modal-content` div
 * and add `role="dialog" aria-modal="true" aria-labelledby="…"` yourself.
 *
 * Only ConfirmDialog/CommandPalette handled Escape before this; every form modal
 * now shares one correct, accessible shell.
 */
export function useModalA11y(ref: RefObject<HTMLElement | null>, opts: Options = {}): void {
  const { onClose, onSubmit, noAutoFocus } = opts;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    if (!noAutoFocus) {
      const els = focusables();
      const preferred =
        els.find((el) => ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) ?? els[0];
      // Defer so the element exists after the entrance animation frame.
      requestAnimationFrame(() => preferred?.focus());
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === "Enter" && onSubmit) {
        const t = e.target as HTMLElement;
        if (
          t.tagName !== "TEXTAREA" &&
          t.tagName !== "BUTTON" &&
          t.tagName !== "SELECT" &&
          !t.isContentEditable
        ) {
          e.preventDefault();
          onSubmit();
        }
        return;
      }
      if (e.key === "Tab") {
        const els = focusables();
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [ref, onClose, onSubmit, noAutoFocus]);
}
