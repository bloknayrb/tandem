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
  DocumentTabs: () => import("../tabs/DocumentTabs.svelte"),
  FileOpenDialog: () => import("../components/FileOpenDialog.svelte"),
  DocumentHealth: () => import("../panels/DocumentHealth.svelte"),
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
  // Settings & misc components (issue #471)
  AccessibilitySettings: () => import("../components/AccessibilitySettings.svelte"),
  AppearanceSettings: () => import("../components/AppearanceSettings.svelte"),
  EditorSettings: () => import("../components/EditorSettings.svelte"),
  SettingsPopover: () => import("../components/SettingsPopover.svelte"),
  CoworkSettings: () => import("../components/CoworkSettings.svelte"),
  CoworkOnboardingStep: () => import("../components/CoworkOnboardingStep.svelte"),
  CoworkAdminDeclinedModal: () => import("../components/CoworkAdminDeclinedModal.svelte"),
  OnboardingTutorial: () => import("../components/OnboardingTutorial.svelte"),
  HelpModal: () => import("../components/HelpModal.svelte"),
  ConnectionBanner: () => import("../components/ConnectionBanner.svelte"),
  EmptyState: () => import("../components/EmptyState.svelte"),
  ReviewOnlyBanner: () => import("../components/ReviewOnlyBanner.svelte"),
  ToastContainer: () => import("../components/ToastContainer.svelte"),
  PanelSlot: () => import("../components/PanelSlot.svelte"),
  ErrorBoundaryHarness: () => import("./ErrorBoundaryHarness.svelte"),
  StatusBar: () => import("../status/StatusBar.svelte"),
};
