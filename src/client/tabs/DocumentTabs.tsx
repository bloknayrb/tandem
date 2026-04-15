import React, { useCallback, useEffect, useRef, useState } from "react";
import { FileOpenDialog } from "../components/FileOpenDialog";
import { useTabDirty } from "../hooks/useTabDirty";
import type { OpenTab } from "../types";

interface DocumentTabsProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  reorder?: (fromId: string, toId: string, side?: "left" | "right") => void;
  reduceMotion?: boolean;
}

const FORMAT_ICONS: Record<string, string> = {
  md: "M",
  txt: "T",
  html: "H",
  docx: "W",
};

interface TabItemProps {
  tab: OpenTab;
  isActive: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  draggable: boolean;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  onDragLeave: () => void;
  dropIndicator: "left" | "right" | null;
  onKeyDown: (e: React.KeyboardEvent, id: string) => void;
}

/** Extracted so useTabDirty can be called per-tab (hooks can't run in loops). */
function TabItem({
  tab,
  isActive,
  onSwitch,
  onClose,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onDragLeave,
  dropIndicator,
  onKeyDown,
}: TabItemProps) {
  const isDirty = useTabDirty(tab);

  return (
    <div
      data-testid={`tab-${tab.id}`}
      data-active={isActive}
      onClick={() => onSwitch(tab.id)}
      draggable={draggable}
      tabIndex={0}
      onDragStart={(e) => onDragStart(e, tab.id)}
      onDragOver={(e) => onDragOver(e, tab.id)}
      onDrop={(e) => onDrop(e, tab.id)}
      onDragEnd={onDragEnd}
      onDragLeave={onDragLeave}
      onKeyDown={(e) => onKeyDown(e, tab.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 12px",
        fontSize: "13px",
        cursor: "pointer",
        background: isActive ? "#fff" : "transparent",
        color: isActive ? "var(--tandem-fg)" : "var(--tandem-fg-muted)",
        borderTop: isActive ? "2px solid var(--tandem-accent)" : "2px solid transparent",
        borderBottom: isActive ? "1px solid #fff" : "1px solid transparent",
        borderLeft:
          dropIndicator === "left" ? "2px solid var(--tandem-accent)" : "2px solid transparent",
        borderRight:
          dropIndicator === "right" ? "2px solid var(--tandem-accent)" : "2px solid transparent",
        marginBottom: "-1px",
        userSelect: "none",
        whiteSpace: "nowrap",
        transition: "background 0.15s, color 0.15s",
        flexShrink: 0,
      }}
    >
      {isDirty && (
        <span
          data-testid={`unsaved-indicator-${tab.id}`}
          style={{ color: "#f59e0b", fontSize: "10px" }}
        >
          ●
        </span>
      )}
      <span
        style={{
          fontSize: "10px",
          fontWeight: 700,
          color: isActive ? "var(--tandem-accent)" : "var(--tandem-fg-subtle)",
          width: "14px",
          textAlign: "center",
        }}
      >
        {FORMAT_ICONS[tab.format] || "?"}
      </span>
      <span
        data-testid={`tab-name-${tab.id}`}
        title={tab.filePath}
        style={{
          fontWeight: isActive ? 500 : 400,
          maxWidth: "160px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {tab.fileName}
      </span>
      {tab.readOnly && (
        <span
          style={{
            fontSize: "9px",
            color: "#92400e",
            background: "#fef3c7",
            padding: "0 3px",
            borderRadius: "2px",
          }}
        >
          RO
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        onDragOver={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "14px",
          lineHeight: 1,
          color: "var(--tandem-fg-subtle)",
          padding: "0 2px",
          borderRadius: "2px",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--tandem-error)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--tandem-fg-subtle)")}
        title="Close document"
      >
        ×
      </button>
    </div>
  );
}

/** Scrollbar-hiding style tag — injected once. */
const SCROLLBAR_HIDE_CLASS = "tandem-tab-scroll-hide";
function ScrollbarHideStyle() {
  return (
    <style>{`
      .${SCROLLBAR_HIDE_CLASS} {
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .${SCROLLBAR_HIDE_CLASS}::-webkit-scrollbar {
        display: none;
      }
    `}</style>
  );
}

const ARROW_BTN_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  minWidth: "28px",
  background: "linear-gradient(to right, var(--tandem-surface-muted) 70%, transparent)",
  border: "none",
  cursor: "pointer",
  fontSize: "12px",
  color: "var(--tandem-fg-muted)",
  padding: 0,
  zIndex: 1,
};

const ARROW_BTN_RIGHT_STYLE: React.CSSProperties = {
  ...ARROW_BTN_STYLE,
  background: "linear-gradient(to left, var(--tandem-surface-muted) 70%, transparent)",
};

export function DocumentTabs({
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  reorder,
  reduceMotion,
}: DocumentTabsProps) {
  const scrollBehavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
  const [showDialog, setShowDialog] = useState(false);
  /** Prevent double-click on close button from firing multiple close requests. */
  const closingIdsRef = useRef<Set<string>>(new Set());
  // Clean up stale entries when tabs change (closed tab removed from DOM)
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    for (const id of closingIdsRef.current) {
      if (!currentIds.has(id)) closingIdsRef.current.delete(id);
    }
  }, [tabs]);
  const guardedClose = useCallback(
    (tabId: string) => {
      if (closingIdsRef.current.has(tabId)) return;
      closingIdsRef.current.add(tabId);
      onTabClose(tabId);
    },
    [onTabClose],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    side: "left" | "right";
  } | null>(null);

  function clearDragState(): void {
    setDraggedId(null);
    setDropTarget(null);
  }

  // Overflow detection
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [updateScrollState]);

  // Re-check overflow when tabs change
  useEffect(() => {
    updateScrollState();
  }, [tabs.length, updateScrollState]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-testid="tab-${activeTabId}"]`);
    if (el) {
      (el as HTMLElement).scrollIntoView({
        inline: "nearest",
        block: "nearest",
        behavior: scrollBehavior,
      });
    }
  }, [activeTabId, scrollBehavior]);

  // Clear drag state when tab list changes mid-drag
  useEffect(() => {
    clearDragState();
  }, [tabs.length]);

  // DnD handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, id: string) => {
      e.preventDefault();
      if (!draggedId || draggedId === id) {
        setDropTarget(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const side = e.clientX < midX ? "left" : "right";
      setDropTarget({ id, side });
    },
    [draggedId],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain");
      if (fromId && fromId !== targetId && reorder) {
        // Use the drop indicator side to determine insert position
        const rect = e.currentTarget.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const side = e.clientX < midX ? "left" : "right";
        reorder(fromId, targetId, side);
      }
      clearDragState();
    },
    [reorder],
  );

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  // Keyboard reordering (Alt+Arrow swaps with neighbor)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string) => {
      if (!e.altKey || !reorder) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();

      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;

      if (e.key === "ArrowLeft" && idx > 0) {
        // Place this tab before the one to its left
        reorder(id, tabs[idx - 1].id);
      } else if (e.key === "ArrowRight" && idx < tabs.length - 1) {
        // Place the neighbor before this tab (effectively swapping right)
        reorder(tabs[idx + 1].id, id);
      }
    },
    [tabs, reorder],
  );

  const scrollLeft = useCallback(() => {
    scrollRef.current?.scrollBy({ left: -150, behavior: scrollBehavior });
  }, [scrollBehavior]);

  const scrollRight = useCallback(() => {
    scrollRef.current?.scrollBy({ left: 150, behavior: scrollBehavior });
  }, [scrollBehavior]);

  const singleTab = tabs.length <= 1;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        background: "var(--tandem-surface-muted)",
        borderBottom: "1px solid var(--tandem-border)",
        minHeight: "32px",
      }}
    >
      <ScrollbarHideStyle />
      {canScrollLeft && (
        <button
          data-testid="tab-scroll-left"
          onClick={scrollLeft}
          style={ARROW_BTN_STYLE}
          title="Scroll tabs left"
        >
          ◀
        </button>
      )}
      <div
        ref={scrollRef}
        data-testid="tab-scroll-container"
        className={SCROLLBAR_HIDE_CLASS}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1px",
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          padding: "0 4px",
        }}
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSwitch={onTabSwitch}
            onClose={guardedClose}
            draggable={!singleTab}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            onDragLeave={handleDragLeave}
            dropIndicator={dropTarget?.id === tab.id ? dropTarget.side : null}
            onKeyDown={handleKeyDown}
          />
        ))}
      </div>
      {canScrollRight && (
        <button
          data-testid="tab-scroll-right"
          onClick={scrollRight}
          style={ARROW_BTN_RIGHT_STYLE}
          title="Scroll tabs right"
        >
          ▶
        </button>
      )}
      <button
        onClick={() => setShowDialog(true)}
        data-testid="open-file-btn"
        title="Open file"
        style={{
          background: "none",
          border: "1px solid var(--tandem-border-strong)",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "16px",
          lineHeight: 1,
          color: "var(--tandem-fg-muted)",
          padding: "2px 8px",
          marginLeft: "4px",
          marginRight: "8px",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--tandem-accent)";
          e.currentTarget.style.borderColor = "var(--tandem-accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--tandem-fg-muted)";
          e.currentTarget.style.borderColor = "var(--tandem-border-strong)";
        }}
      >
        +
      </button>
      {showDialog && <FileOpenDialog onClose={() => setShowDialog(false)} />}
    </div>
  );
}
