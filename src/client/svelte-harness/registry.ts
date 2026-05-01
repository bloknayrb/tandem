import type { Component } from "svelte";

/**
 * Registry of Svelte components available in the dev harness.
 * Each entry is a lazy import: `() => import("../path/to/Component.svelte")`.
 * Subsequent PRs add entries here as components are ported from React.
 */
// Components may require props; use Record<string, unknown> to allow any component shape.
// The harness renders components without props (for visual smoke-testing only).
// biome-ignore lint/suspicious/noExplicitAny: intentional harness escape hatch
export const registry: Record<string, () => Promise<{ default: Component<any> }>> = {
  HookDebug: () => import("./HookDebug.svelte"),
  Editor: () => import("./EditorHarness.svelte"),
  DocumentHealth: () => import("../panels/DocumentHealth.svelte"),
  ReviewSummary: () => import("../panels/ReviewSummary.svelte"),
  FilterSelect: () => import("../panels/FilterSelect.svelte"),
  FilterBar: () => import("../panels/FilterBar.svelte"),
  CommentThread: () => import("../panels/CommentThread.svelte"),
  AnnotationEditForm: () => import("../panels/AnnotationEditForm.svelte"),
  AnnotationCardActions: () => import("../panels/AnnotationCardActions.svelte"),
  ReplyThread: () => import("../panels/ReplyThread.svelte"),
  AnnotationCard: () => import("../panels/AnnotationCard.svelte"),
  BulkActions: () => import("../panels/BulkActions.svelte"),
  ApplyChangesButton: () => import("../components/ApplyChangesButton.svelte"),
  SidePanel: () => import("../panels/SidePanel.svelte"),
  ChatPanel: () => import("../panels/ChatPanel.svelte"),
};
