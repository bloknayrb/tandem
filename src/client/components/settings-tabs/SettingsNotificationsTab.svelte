<script lang="ts">
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import type { ChatNotificationContent, ChatSound } from "../../hooks/useTandemSettings";
import { sendTestNotification } from "../../notifications/backend";
import { playChime } from "../../notifications/chimes";
import {
  requestWebNotificationPermission,
  type WebNotificationPermission,
  webNotificationPermission,
} from "../../notifications/web-notifier";
import { disabledControlStyle } from "../../utils/colors";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Keep `$props()` as a single proxy variable and read fields via `ctx.foo`
// (feedback_svelte_getter_destructuring).
let ctx: SettingsTabContext = $props();

const desktop = isTauriRuntime();
// Desktop permission lives in the OS (the plugin reports "granted" there
// unconditionally), so only the browser has a state worth showing.
let permission = $state<WebNotificationPermission>(
  desktop ? "granted" : webNotificationPermission(),
);

const CONTENT_OPTIONS: { value: ChatNotificationContent; label: string }[] = [
  { value: "generic", label: "Generic — “Claude replied”" },
  { value: "document", label: "Document name — “Claude replied in report.md”" },
  { value: "preview", label: "Message preview — the start of the reply" },
];
const SOUND_OPTIONS: { value: ChatSound; label: string }[] = [
  { value: "chime", label: "Chime" },
  { value: "bell", label: "Bell" },
  { value: "pop", label: "Pop" },
  { value: "ping", label: "Ping" },
  { value: "none", label: "None" },
];

const selectStyle =
  "width: 100%; padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2);";
const toggleStyle =
  "display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;";
const buttonStyle =
  "padding: 4px 10px; font-size: 12px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: pointer;";

// Only ever from a click — browsers auto-deny a prompt with no user gesture.
async function allowNotifications(): Promise<void> {
  permission = await requestWebNotificationPermission();
}

async function setEnabled(enabled: boolean): Promise<void> {
  ctx.onUpdate({ chatNotifications: enabled });
  if (enabled && !desktop && permission === "default") await allowNotifications();
}

function sendTest(): void {
  sendTestNotification();
  playChime(ctx.settings.chatSound, ctx.settings.chatSoundVolume);
}
</script>

<div>
  <div class="settings-section-label">When Claude replies in chat</div>
  <div class="settings-hint">
    While Tandem isn't the window you're using, a reply shows a notification and
    {desktop ? "flashes the taskbar icon" : "a count in the tab title"}. The sound plays either way.
  </div>
</div>

<div data-testid="notifications-permission-status" class="settings-hint">
  {#if desktop}
    Whether notifications appear is managed by your operating system's notification settings.
  {:else if permission === "granted"}
    This browser allows Tandem's notifications.
  {:else if permission === "denied"}
    Notifications are blocked for this site. Allow them in your browser's site settings.
  {:else if permission === "unsupported"}
    This browser doesn't support notifications.
  {:else}
    <span>This browser needs your permission to show notifications.</span>
    <button
      type="button"
      data-testid="notifications-allow-button"
      onclick={allowNotifications}
      style="{buttonStyle} margin-left: var(--tandem-space-2);"
    >
      Allow notifications
    </button>
  {/if}
</div>

<label data-testid="notifications-enable-toggle" style={toggleStyle}>
  <input
    type="checkbox"
    checked={ctx.settings.chatNotifications}
    disabled={ctx.readOnly}
    onchange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
    style="accent-color: var(--tandem-accent); {disabledControlStyle(ctx.readOnly)}"
  />
  <span>Show a notification</span>
</label>

<div>
  <label for="notifications-content-select" class="settings-section-label">Notification content</label>
  <select
    id="notifications-content-select"
    data-testid="notifications-content-select"
    value={ctx.settings.chatNotificationContent}
    disabled={ctx.readOnly}
    onchange={(e) =>
      ctx.onUpdate({
        chatNotificationContent: (e.target as HTMLSelectElement).value as ChatNotificationContent,
      })}
    style="{selectStyle} {disabledControlStyle(ctx.readOnly)}"
  >
    {#each CONTENT_OPTIONS as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Notifications can appear on your lock screen.
  </div>
</div>

<label data-testid="notifications-flash-toggle" style={toggleStyle}>
  <input
    type="checkbox"
    checked={ctx.settings.chatAttentionFlash}
    disabled={ctx.readOnly}
    onchange={(e) => ctx.onUpdate({ chatAttentionFlash: (e.target as HTMLInputElement).checked })}
    style="accent-color: var(--tandem-accent); {disabledControlStyle(ctx.readOnly)}"
  />
  <span>{desktop ? "Flash the taskbar icon until you switch to Tandem" : "Show the unread count in the tab title"}</span>
</label>

<div>
  <label data-testid="notifications-visible-toggle" style={toggleStyle}>
    <input
      type="checkbox"
      checked={ctx.settings.chatSeenWhenVisible}
      disabled={ctx.readOnly}
      onchange={(e) => ctx.onUpdate({ chatSeenWhenVisible: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(ctx.readOnly)}"
    />
    <span>I keep Tandem visible beside other apps</span>
  </label>
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Replies count as read whenever Tandem is open on screen, even behind other windows. You'll hear
    the sound but get no notification while it's open.
  </div>
</div>

<div>
  <label for="notifications-sound-select" class="settings-section-label">Sound</label>
  <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
    <select
      id="notifications-sound-select"
      data-testid="notifications-sound-select"
      value={ctx.settings.chatSound}
      disabled={ctx.readOnly}
      onchange={(e) => {
        const sound = (e.target as HTMLSelectElement).value as ChatSound;
        ctx.onUpdate({ chatSound: sound });
        playChime(sound, ctx.settings.chatSoundVolume);
      }}
      style="{selectStyle} flex: 1; {disabledControlStyle(ctx.readOnly)}"
    >
      {#each SOUND_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <button
      type="button"
      data-testid="notifications-sound-preview"
      disabled={ctx.settings.chatSound === "none"}
      onclick={() => playChime(ctx.settings.chatSound, ctx.settings.chatSoundVolume)}
      style="{buttonStyle} {disabledControlStyle(ctx.settings.chatSound === 'none')}"
    >
      Preview
    </button>
  </div>
</div>

<div>
  <div id="notifications-volume-label" class="settings-section-label">Volume</div>
  <input
    data-testid="notifications-volume-slider"
    type="range"
    min="0"
    max="100"
    step="5"
    aria-labelledby="notifications-volume-label"
    value={ctx.settings.chatSoundVolume}
    disabled={ctx.readOnly || ctx.settings.chatSound === "none"}
    oninput={(e) => ctx.onUpdate({ chatSoundVolume: Number((e.target as HTMLInputElement).value) })}
    onchange={() => playChime(ctx.settings.chatSound, ctx.settings.chatSoundVolume)}
    style="width: 100%; accent-color: var(--tandem-accent); {disabledControlStyle(ctx.readOnly || ctx.settings.chatSound === 'none', 'auto')}"
  />
</div>

<div>
  <button
    type="button"
    data-testid="notifications-test-button"
    disabled={!desktop && permission !== "granted"}
    onclick={sendTest}
    style="{buttonStyle} {disabledControlStyle(!desktop && permission !== 'granted')}"
  >
    Send a test notification
  </button>
</div>
