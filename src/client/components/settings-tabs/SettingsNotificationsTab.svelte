<script lang="ts">
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import type { ChatNotificationContent, ChatSound } from "../../hooks/useTandemSettings";
import { sendTestNotification } from "../../notifications/backend";
import { playChime, previewChime } from "../../notifications/chimes";
import {
  requestWebNotificationPermission,
  type WebNotificationPermission,
  watchWebNotificationPermission,
  webNotificationPermission,
} from "../../notifications/web-notifier";
import { disabledControlStyle } from "../../utils/colors";
import LiveRegion from "../LiveRegion.svelte";
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

// A permission changed in the browser's site settings, or answered in another
// tab, reaches the status line without reopening Settings. Browser only: the
// desktop build never queries `navigator.permissions`.
$effect(() => {
  if (desktop) return;
  return watchWebNotificationPermission((p) => {
    permission = p;
  });
});

const CONTENT_OPTIONS: { value: ChatNotificationContent; label: string }[] = [
  { value: "generic", label: "Generic — “Claude replied”" },
  { value: "document", label: "Document name — “Claude replied in report.md”" },
  { value: "preview", label: "Message preview — the start of the reply" },
];
// Names as auditioned when the sounds were chosen; `hint` is each option's tooltip.
const SOUND_OPTIONS: { value: ChatSound; label: string; hint: string }[] = [
  {
    value: "marimba-glock",
    label: "Marimba and glockenspiel",
    hint: "A wooden note with a quiet bell on top",
  },
  {
    value: "harp-glock",
    label: "Harp and glockenspiel",
    hint: "Pluck and bell together, close to a celesta",
  },
  {
    value: "piano-vibes",
    label: "Piano and vibraphone",
    hint: "A soft piano attack with a long vibraphone ring",
  },
  {
    value: "vibes-low-marimba",
    label: "Vibes over low marimba",
    hint: "Vibraphone with a marimba an octave below",
  },
  {
    value: "glock-to-vibes",
    label: "Glockenspiel hands off to vibes",
    hint: "Bright high note, warm low note",
  },
  {
    value: "balafon-chimes",
    label: "Balafon and hand chimes",
    hint: "A woody buzz, then a ringing chime",
  },
  {
    value: "xylo-chimes",
    label: "Xylophone tap into chimes",
    hint: "A light tap, like a striker, then the chimes ring",
  },
  {
    value: "harp-vibes-glock",
    label: "Harp, vibes and glockenspiel",
    hint: "Pluck, ring and sparkle: the fullest blend",
  },
  {
    value: "chimes-low-harp",
    label: "Hand chimes over low harp",
    hint: "Hand chimes with a harp an octave below",
  },
  { value: "none", label: "None", hint: "No sound" },
];
const SOUND_ERROR = "Couldn't load this sound. Try Preview again.";

let soundError = $state(false);
// Only the newest preview's outcome may set or clear the error: an older one
// can resolve later (it waited on a slower load) and must not overwrite it.
let previewToken = 0;

async function preview(sound: ChatSound, volume: number): Promise<void> {
  const token = ++previewToken;
  soundError = false;
  const status = await previewChime(sound, volume);
  if (token !== previewToken) return;
  soundError = status === "failed" || status === "timeout";
}

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
  <div class="settings-section-label">When Claude replies</div>
  <div class="settings-hint">
    In chat, or in the thread of a comment you wrote. While Tandem isn't the window you're
    using, a reply shows a notification and
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
    Replies count as read whenever Tandem is on screen with chat (or the comment's open thread)
    showing, even behind other windows.
    While it's on screen you'll hear the sound but get no notification.
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
        void preview(sound, ctx.settings.chatSoundVolume);
      }}
      style="{selectStyle} flex: 1; {disabledControlStyle(ctx.readOnly)}"
    >
      {#each SOUND_OPTIONS as opt (opt.value)}
        <option value={opt.value} title={opt.hint}>{opt.label}</option>
      {/each}
    </select>
    <button
      type="button"
      data-testid="notifications-sound-preview"
      disabled={ctx.settings.chatSound === "none"}
      onclick={() => void preview(ctx.settings.chatSound, ctx.settings.chatSoundVolume)}
      style="{buttonStyle} {disabledControlStyle(ctx.settings.chatSound === 'none')}"
    >
      Preview
    </button>
  </div>
  {#if soundError}
    <div data-testid="notifications-sound-error" aria-hidden="true" class="settings-hint" style="color: var(--tandem-error-fg);">{SOUND_ERROR}</div>
  {/if}
  <LiveRegion message={soundError ? SOUND_ERROR : ""} srOnly />
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
    onchange={() => void preview(ctx.settings.chatSound, ctx.settings.chatSoundVolume)}
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
