import { Check } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface AppleSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface MenuGeometry {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  minWidth: number;
  hasRect: boolean;
}

/**
 * macOS / Apple Music Liquid Glass Pop-Up Select (`role="combobox"` + portaled `role="listbox"`).
 * Replaces native OS `<select>` elements with a cohesive translucent vibrancy menu, left checkmark gutter,
 * smart viewport edge flip, and full keyboard navigation.
 */
export function AppleSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  variant = "subtle",
  align,
  disabled = false,
  className = "",
}: {
  value: T;
  options: ReadonlyArray<AppleSelectOption<T>>;
  onChange: (next: T) => void;
  ariaLabel?: string;
  variant?: "subtle" | "field";
  align?: "left" | "right";
  disabled?: boolean;
  className?: string;
}) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((opt) => opt.value === value),
    ),
  );
  const [geometry, setGeometry] = useState<MenuGeometry>({ minWidth: 148, hasRect: false });

  const resolvedAlign = align ?? (variant === "field" ? "left" : "right");
  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedLabel = options[selectedIndex]?.label ?? options[0]?.label ?? "";

  const computeGeometry = (): MenuGeometry => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") {
      return { minWidth: 148, hasRect: false };
    }
    const rect = el.getBoundingClientRect();
    const hasRect = rect.height > 0 && window.innerHeight > 0;
    if (!hasRect) {
      return { minWidth: 148, hasRect: false };
    }
    const estimatedMenuHeight = Math.min(280, options.length * 32 + 12);
    const openUpward =
      window.innerHeight - rect.bottom < estimatedMenuHeight + 24 && rect.top > estimatedMenuHeight;
    const minWidth = Math.max(Math.round(rect.width), 148);

    return {
      hasRect: true,
      minWidth,
      ...(openUpward
        ? { bottom: Math.max(8, window.innerHeight - rect.top + 6) }
        : { top: Math.max(8, rect.bottom + 6) }),
      ...(resolvedAlign === "right"
        ? { right: Math.max(8, window.innerWidth - rect.right) }
        : { left: Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8)) }),
    };
  };

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setGeometry(computeGeometry());
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (triggerRef.current?.contains(target) || menuRef.current?.contains(target))) {
        return;
      }
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const onViewportChange = () => setOpen(false);

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  const selectAtIndex = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    setOpen(false);
    if (opt.value !== value) {
      onChange(opt.value);
    }
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        setActiveIndex((prev) => (prev + 1) % options.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
      }
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      selectAtIndex(activeIndex);
    }
  };

  const baseTriggerClass =
    variant === "field"
      ? `inline-flex h-[38px] items-center justify-between gap-2 rounded-lg border px-3 text-xs font-medium transition-colors focus:outline-none ${
          open
            ? "border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] text-[var(--tv-text)]"
            : "border-[var(--tv-border)] bg-[var(--tv-bg)] text-[var(--tv-text)] hover:border-[var(--tv-border-strong)]"
        }`
      : `inline-flex h-8 items-center justify-between gap-2 rounded-[8px] px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tv-border-strong)] ${
          open
            ? "bg-[var(--tv-nav-active)] text-[var(--tv-text)]"
            : "bg-[var(--tv-lcd-bg)] text-[var(--tv-text-muted)] hover:bg-[var(--tv-nav-active)] hover:text-[var(--tv-text)]"
        }`;

  const menuStyle: CSSProperties = geometry.hasRect
    ? {
        position: "fixed",
        top: geometry.top,
        bottom: geometry.bottom,
        left: geometry.left,
        right: geometry.right,
        minWidth: geometry.minWidth,
        boxShadow: "var(--tv-glass-highlight), var(--tv-glass-shadow)",
        zIndex: "var(--tv-z-dropdown)",
      }
    : {
        position: "fixed",
        top: 0,
        right: 0,
        minWidth: geometry.minWidth,
        boxShadow: "var(--tv-glass-highlight), var(--tv-glass-shadow)",
        zIndex: "var(--tv-z-dropdown)",
      };

  const menuNode = open ? (
    <div
      ref={menuRef}
      id={listboxId}
      /* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA 1.2 select-only combobox requires custom elements for Liquid Glass popover */
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      onPointerDown={(e) => e.stopPropagation()}
      className="tv-popover-in tv-subtle-scrollbar max-h-72 overflow-y-auto rounded-[12px] border border-[var(--tv-glass-border)] bg-[var(--tv-surface-elevated)]/92 p-1 backdrop-blur-[28px] backdrop-saturate-[180%] select-none"
      style={menuStyle}
    >
      {options.map((opt, idx) => {
        const isSelected = opt.value === value;
        const isHighlighted = idx === activeIndex;
        return (
          <div
            key={String(opt.value)}
            id={`${listboxId}-opt-${idx}`}
            /* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA 1.2 select-only combobox option item */
            role="option"
            tabIndex={-1}
            aria-selected={isSelected}
            onPointerEnter={() => setActiveIndex(idx)}
            onClick={(e) => {
              e.stopPropagation();
              selectAtIndex(idx);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectAtIndex(idx);
              }
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-xs transition-colors ${
              isHighlighted
                ? "bg-[var(--tv-nav-active)] text-[var(--tv-text)]"
                : isSelected
                  ? "text-[var(--tv-text)]"
                  : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-nav-active)] hover:text-[var(--tv-text)]"
            } ${isSelected ? "font-semibold" : "font-normal"}`}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {isSelected && <Check className="h-3.5 w-3.5 stroke-[2.5] text-[var(--tv-accent)]" />}
            </span>
            <span className="truncate">{opt.label}</span>
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        /* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA 1.2 select-only combobox trigger */
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-opt-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        className={`${baseTriggerClass} disabled:cursor-not-allowed disabled:opacity-40 ${className}`.trim()}
      >
        <span className="truncate">{selectedLabel}</span>
        {/* macOS signature chevron.up.chevron.down pop-up indicator */}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-[var(--tv-text-subtle)]"
        >
          <path
            d="M5.25 6L8 3.25L10.75 6M5.25 10L8 12.75L10.75 10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (typeof document !== "undefined" ? createPortal(menuNode, document.body) : menuNode)}
    </>
  );
}
