import { type RefObject, useEffect, useRef, useState } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(", ");

function isFocusableVisible(el: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => isFocusableVisible(el, container));
}

const inertSyncCallbacks = new Set<() => void>();

/**
 * Registers a synchronous callback that reconciles background `inert` state on live DOM nodes.
 * Invoked immediately before `useModalFocusTrap` restores focus on close so Chromium never blocks
 * `previouslyFocused.focus()` due to stale `inert` attributes awaiting passive `useEffect` flush (U04).
 */
export function registerInertSynchronizer(syncFn: () => void): () => void {
  inertSyncCallbacks.add(syncFn);
  return () => {
    inertSyncCallbacks.delete(syncFn);
  };
}

function flushInertSynchronizers(): void {
  for (const syncFn of inertSyncCallbacks) {
    syncFn();
  }
}

export interface UseModalFocusTrapOptions {
  onClose?: () => void;
}

/**
 * Traps keyboard Tab/Shift+Tab focus inside `containerRef` while `active` is true,
 * moves initial focus into the modal/drawer, handles Escape via `onClose`, and
 * restores focus to the triggering element on deactivation.
 */
export function useModalFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options?: UseModalFocusTrapOptions,
): void {
  const onCloseRef = useRef(options?.onClose);
  onCloseRef.current = options?.onClose;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!container.contains(document.activeElement)) {
      const focusables = getFocusableElements(container);
      const firstTarget = focusables[0];
      if (firstTarget) {
        firstTarget.focus();
      } else {
        if (!container.hasAttribute("tabindex")) {
          container.setAttribute("tabindex", "-1");
        }
        container.focus();
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      const current = document.activeElement;
      if (event.shiftKey) {
        if (!container.contains(current) || current === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!container.contains(current) || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // U04: Release background inert attributes synchronously BEFORE restoring focus (real Chromium requirement)
      flushInertSynchronizers();
      if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}

function readIsBelowWidth(minDesktopPx: number): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return !window.matchMedia(`(min-width: ${minDesktopPx}px)`).matches;
  }
  return window.innerWidth < minDesktopPx;
}

/**
 * Returns true when viewport width is strictly below `minDesktopPx` (overlay drawer mode).
 * Safely supports jsdom / environments without `window.matchMedia`.
 */
export function useIsOverlayViewport(minDesktopPx: number): boolean {
  const [isOverlay, setIsOverlay] = useState(() => readIsBelowWidth(minDesktopPx));

  useEffect(() => {
    const update = () => setIsOverlay(readIsBelowWidth(minDesktopPx));
    update();

    if (typeof window.matchMedia === "function") {
      const mql = window.matchMedia(`(min-width: ${minDesktopPx}px)`);
      const onChange = () => setIsOverlay(!mql.matches);
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [minDesktopPx]);

  return isOverlay;
}

/**
 * Imperatively sets both the `inert` property and attribute for full React 18 / TypeScript / jsdom compatibility.
 */
export function setElementInert(element: HTMLElement | null, inert: boolean): void {
  if (!element) return;
  (element as HTMLElement & { inert: boolean }).inert = inert;
  if (inert) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
}
