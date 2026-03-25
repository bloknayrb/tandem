import React, { useState } from "react";
import type { OpenTab } from "../types";
import { FileOpenDialog } from "../components/FileOpenDialog";

interface DocumentTabsProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

const FORMAT_ICONS: Record<string, string> = {
  md: "M",
  txt: "T",
  html: "H",
  docx: "W",
};

export function DocumentTabs({ tabs, activeTabId, onTabSwitch, onTabClose }: DocumentTabsProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1px",
        padding: "0 8px",
        background: "#f3f4f6",
        borderBottom: "1px solid #e5e7eb",
        minHeight: "32px",
        overflow: "hidden",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            onClick={() => onTabSwitch(tab.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 12px",
              fontSize: "13px",
              cursor: "pointer",
              background: isActive ? "#fff" : "transparent",
              color: isActive ? "#111827" : "#6b7280",
              borderTop: isActive ? "2px solid #6366f1" : "2px solid transparent",
              borderBottom: isActive ? "1px solid #fff" : "1px solid transparent",
              marginBottom: "-1px",
              userSelect: "none",
              whiteSpace: "nowrap",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            <span
              style={{
                fontSize: "10px",
                fontWeight: 700,
                color: isActive ? "#6366f1" : "#9ca3af",
                width: "14px",
                textAlign: "center",
              }}
            >
              {FORMAT_ICONS[tab.format] || "?"}
            </span>
            <span style={{ fontWeight: isActive ? 500 : 400 }}>{tab.fileName}</span>
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
                onTabClose(tab.id);
              }}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1,
                color: "#9ca3af",
                padding: "0 2px",
                borderRadius: "2px",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#ef4444")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#9ca3af")}
              title="Close document"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        onClick={() => setShowDialog(true)}
        data-testid="open-file-btn"
        title="Open file"
        style={{
          background: "none",
          border: "1px solid #d1d5db",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "16px",
          lineHeight: 1,
          color: "#6b7280",
          padding: "2px 8px",
          marginLeft: "4px",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "#6366f1";
          e.currentTarget.style.borderColor = "#6366f1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "#6b7280";
          e.currentTarget.style.borderColor = "#d1d5db";
        }}
      >
        +
      </button>
      {showDialog && <FileOpenDialog onClose={() => setShowDialog(false)} />}
    </div>
  );
}
