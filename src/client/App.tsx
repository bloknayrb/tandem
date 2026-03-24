import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { Editor } from "./editor/Editor";
import { SidePanel } from "./panels/SidePanel";
import { ChatPanel } from "./panels/ChatPanel";
import { StatusBar } from "./status/StatusBar";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { DocumentTabs } from "./tabs/DocumentTabs";
import { ReviewSummary } from "./panels/ReviewSummary";
import {
  INTERRUPTION_MODE_DEFAULT,
  INTERRUPTION_MODE_KEY,
  REVIEW_BANNER_THRESHOLD,
} from "../shared/constants";
import type { InterruptionMode } from "../shared/types";
import { InterruptionModeSchema } from "../shared/types";
import { useAnnotationGate } from "./hooks/useAnnotationGate";
import { useYjsSync } from "./hooks/useYjsSync";
import type { DocListEntry, OpenTab } from "./types";

export type { DocListEntry, OpenTab };

export default function App() {
  const {
    tabs,
    activeTabId,
    setActiveTabId,
    handleTabClose,
    connected,
    setConnected,
    annotations,
    claudeStatus,
    claudeActive,
    readOnly,
    bootstrapYdoc,
    ready,
  } = useYjsSync();

  // Interruption mode — persisted to localStorage
  const [interruptionMode, setInterruptionMode] = useState<InterruptionMode>(() => {
    const saved = localStorage.getItem(INTERRUPTION_MODE_KEY);
    return InterruptionModeSchema.safeParse(saved).success
      ? (saved as InterruptionMode)
      : INTERRUPTION_MODE_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem(INTERRUPTION_MODE_KEY, interruptionMode);
  }, [interruptionMode]);

  const { visibleAnnotations, heldCount } = useAnnotationGate(annotations, interruptionMode);

  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [reviewSummaryData, setReviewSummaryData] = useState<{
    accepted: number;
    dismissed: number;
    total: number;
  } | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [, setEditorVersion] = useState(0);

  const editorRef = useRef<TiptapEditor | null>(null);
  const prevPendingRef = useRef<number>(0);

  const handleEditorReady = useCallback((editor: TiptapEditor | null) => {
    editorRef.current = editor;
    if (editor) setEditorVersion((v) => v + 1);
  }, []);

  // Detect review completion: all pending -> 0 while resolved > 0 (single pass)
  useEffect(() => {
    let pending = 0,
      accepted = 0,
      dismissed = 0;
    for (const a of annotations) {
      if (a.status === "pending") pending++;
      else if (a.status === "accepted") accepted++;
      else dismissed++;
    }
    const total = accepted + dismissed;

    if (prevPendingRef.current > 0 && pending === 0 && total > 0) {
      setReviewSummaryData({ accepted, dismissed, total });
      setShowReviewSummary(true);
    }
    prevPendingRef.current = pending;
  }, [annotations]);

  const pendingCount = useMemo(
    () => annotations.filter((a) => a.status === "pending").length,
    [annotations],
  );

  // Show banner when pending annotations exceed threshold
  useEffect(() => {
    if (pendingCount >= REVIEW_BANNER_THRESHOLD && !reviewMode) {
      setShowBanner(true);
    }
    if (pendingCount === 0) {
      setShowBanner(false);
    }
  }, [pendingCount, reviewMode]);

  const toggleReviewMode = useCallback(() => {
    setReviewMode((prev) => !prev);
    setShowBanner(false);
  }, []);

  const exitReviewMode = useCallback(() => {
    setReviewMode(false);
    setShowBanner(false);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!ready) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "#9ca3af",
        }}
      >
        Connecting...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Toolbar editor={editorRef.current} ydoc={activeTab?.ydoc ?? null} />
      {tabs.length > 0 && (
        <DocumentTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSwitch={setActiveTabId}
          onTabClose={handleTabClose}
        />
      )}
      {showBanner && !reviewMode && (
        <div
          style={{
            padding: "8px 16px",
            background: "#eef2ff",
            borderBottom: "1px solid #c7d2fe",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "13px",
            color: "#4338ca",
          }}
        >
          <span>{pendingCount} annotations pending review.</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={toggleReviewMode}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "1px solid #6366f1",
                borderRadius: "4px",
                background: "#6366f1",
                color: "white",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Review in sequence
            </button>
            <button
              onClick={() => setShowBanner(false)}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                background: "white",
                color: "#6b7280",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "auto", padding: "24px 48px" }}>
          {activeTab ? (
            <Editor
              key={activeTab.id}
              ydoc={activeTab.ydoc}
              provider={activeTab.provider}
              readOnly={readOnly}
              reviewMode={reviewMode}
              activeAnnotationId={activeAnnotationId}
              onConnectionChange={setConnected}
              onEditorReady={handleEditorReady}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "#9ca3af",
              }}
            >
              No document open. Use Claude to open a file with tandem_open.
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "300px",
            borderLeft: "1px solid #e5e7eb",
          }}
        >
          {/* Panel toggle tabs */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid #e5e7eb",
              background: "#f9fafb",
            }}
          >
            <button
              onClick={() => setShowChat(false)}
              style={{
                flex: 1,
                padding: "8px",
                fontSize: "12px",
                fontWeight: showChat ? 400 : 600,
                border: "none",
                borderBottom: showChat ? "none" : "2px solid #6366f1",
                background: "transparent",
                cursor: "pointer",
                color: showChat ? "#6b7280" : "#6366f1",
              }}
            >
              Annotations
            </button>
            <button
              onClick={() => setShowChat(true)}
              style={{
                flex: 1,
                padding: "8px",
                fontSize: "12px",
                fontWeight: showChat ? 600 : 400,
                border: "none",
                borderBottom: showChat ? "2px solid #6366f1" : "none",
                background: "transparent",
                cursor: "pointer",
                color: showChat ? "#6366f1" : "#6b7280",
              }}
            >
              Chat
            </button>
          </div>
          {/* Panel content */}
          {showChat ? (
            <ChatPanel
              ctrlYdoc={bootstrapYdoc}
              editor={editorRef.current}
              activeDocId={activeTabId}
              openDocs={tabs.map((t) => ({ id: t.id, fileName: t.fileName }))}
            />
          ) : (
            <SidePanel
              annotations={visibleAnnotations}
              editor={editorRef.current}
              ydoc={activeTab?.ydoc ?? null}
              heldCount={heldCount}
              interruptionMode={interruptionMode}
              onModeChange={setInterruptionMode}
              reviewMode={reviewMode}
              onToggleReviewMode={toggleReviewMode}
              onExitReviewMode={exitReviewMode}
              activeAnnotationId={activeAnnotationId}
              onActiveAnnotationChange={setActiveAnnotationId}
            />
          )}
        </div>
      </div>
      <StatusBar
        connected={connected}
        claudeStatus={claudeStatus}
        claudeActive={claudeActive}
        readOnly={readOnly}
        documentCount={tabs.length}
        interruptionMode={interruptionMode}
        onModeChange={setInterruptionMode}
        heldCount={heldCount}
      />
      {showReviewSummary && reviewSummaryData && (
        <ReviewSummary
          accepted={reviewSummaryData.accepted}
          dismissed={reviewSummaryData.dismissed}
          total={reviewSummaryData.total}
          onDismiss={() => setShowReviewSummary(false)}
        />
      )}
    </div>
  );
}
