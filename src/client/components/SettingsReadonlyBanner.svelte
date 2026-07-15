<script lang="ts">
import { warningStateColors } from "../utils/colors";

// Surface-wide forward-compat read-only notice, shared by SettingsModal and
// SettingsPopover (same copy, same testid — the snapshot set dedups). Hosts
// gate rendering on their own `readOnly`; this component is presentational.
</script>

<div
  data-testid="settings-readonly-banner"
  role="note"
  style="flex-shrink: 0; padding: var(--tandem-space-2) var(--tandem-space-5); font-size: var(--tandem-text-xs); line-height: 1.4; background: {warningStateColors.background}; border-bottom: 1px solid {warningStateColors.border}; color: {warningStateColors.color};"
>
  Settings are read-only — they were saved by a newer version of Tandem. Changes are disabled to
  protect them.
</div>
