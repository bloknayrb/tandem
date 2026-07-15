<script lang="ts">
import type { SettingsTabContext } from "../SettingsModal.svelte";
import ShortcutEditorList from "../ShortcutEditorList.svelte";

// Destructure directly off $props() so each named local stays a live getter
// (see SettingsModal's documented getter-freezing gotcha).
let { settings, onUpdate, notify }: SettingsTabContext = $props();
</script>

<div data-testid="settings-modal-shortcuts-list">
  <ShortcutEditorList {settings} {onUpdate} {notify} />
</div>
