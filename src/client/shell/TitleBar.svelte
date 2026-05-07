<script lang="ts">
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { onDestroy, onMount } from "svelte";

interface Props {
  title?: string;
}
const { title = "Tandem" }: Props = $props();

let win: TauriWindow | null = null;
let isMaximized = $state(false);
let initFailed = $state(false);
let cleanupListeners: (() => void)[] = [];

onMount(async () => {
  if (!isTauriRuntime()) return;
  try {
    // Re-run the decorum overlay setup now that the WebView page is loaded.
    // create_overlay_titlebar() injects JS hit-test logic that is cleared on
    // page navigation; calling it here (post-load) keeps it alive.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("setup_overlay_titlebar").catch((e: unknown) => {
      console.warn("[TitleBar] setup_overlay_titlebar failed:", e);
    });

    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    win = getCurrentWindow();
    isMaximized = await win.isMaximized();

    const unlistenResize = await win.onResized(async () => {
      try {
        isMaximized = await win!.isMaximized();
      } catch (e) {
        console.warn("[TitleBar] isMaximized check failed on resize:", e);
      }
    });
    const unlistenMove = await win.onMoved(async () => {
      try {
        isMaximized = await win!.isMaximized();
      } catch (e) {
        console.warn("[TitleBar] isMaximized check failed on move:", e);
      }
    });
    cleanupListeners = [unlistenResize, unlistenMove];
  } catch (e) {
    console.error("[TitleBar] Window API initialization failed:", e);
    initFailed = true;
  }
});

onDestroy(() => {
  cleanupListeners.forEach((fn) => fn());
});

async function minimize() {
  try {
    await win?.minimize();
  } catch (e) {
    console.error("[TitleBar] minimize failed:", e);
  }
}

async function toggleMaximize() {
  try {
    await win?.toggleMaximize();
  } catch (e) {
    console.error("[TitleBar] toggleMaximize failed:", e);
  }
}

async function close() {
  try {
    await win?.close();
  } catch (e) {
    console.error("[TitleBar] close failed:", e);
  }
}
</script>

{#if isTauriRuntime() && !initFailed}
	<div class="title-bar">
		<div class="title-bar-left" data-tauri-drag-region>
			<span class="title-bar-title">{title}</span>
		</div>
		<div class="title-bar-controls">
			<button type="button" class="title-bar-btn" aria-label="Minimize" onclick={minimize}>
				<svg
					width="10"
					height="1"
					viewBox="0 0 10 1"
					aria-hidden="true"
					focusable="false"
				>
					<rect width="10" height="1" fill="currentColor" />
				</svg>
			</button>
			<button
				type="button"
				class="title-bar-btn"
				aria-label={isMaximized ? "Restore" : "Maximize"}
				onclick={toggleMaximize}
			>
				{#if isMaximized}
					<svg
						width="10"
						height="10"
						viewBox="0 0 10 10"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M3 0H10V7H7V10H0V3H3V0ZM3 3H1V9H6V7H3V3ZM4 1V6H9V1H4Z"
							fill="currentColor"
						/>
					</svg>
				{:else}
					<svg
						width="10"
						height="10"
						viewBox="0 0 10 10"
						aria-hidden="true"
						focusable="false"
					>
						<path d="M0 0H10V10H0V0ZM1 2V9H9V2H1Z" fill="currentColor" />
					</svg>
				{/if}
			</button>
			<button
				type="button"
				class="title-bar-btn title-bar-close"
				aria-label="Close"
				onclick={close}
			>
				<svg
					width="10"
					height="10"
					viewBox="0 0 10 10"
					aria-hidden="true"
					focusable="false"
				>
					<path
						d="M1 0L0 1L4 5L0 9L1 10L5 6L9 10L10 9L6 5L10 1L9 0L5 4L1 0Z"
						fill="currentColor"
					/>
				</svg>
			</button>
		</div>
	</div>
{/if}

<style>
	.title-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 32px;
		min-height: 32px;
		background: var(--tandem-surface);
		border-bottom: 1px solid var(--tandem-border);
		user-select: none;
		flex-shrink: 0;
	}

	/* drag region — any new sibling between this and .title-bar-controls must carry data-tauri-drag-region too */
	.title-bar-left {
		display: flex;
		align-items: center;
		gap: var(--tandem-space-2);
		padding-left: var(--tandem-space-3);
		min-width: 0;
		flex: 1;
	}

	.title-bar-title {
		font-size: var(--tandem-text-sm);
		color: var(--tandem-fg-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title-bar-controls {
		display: flex;
		height: 100%;
	}

	.title-bar-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 46px;
		height: 100%;
		border: none;
		background: transparent;
		color: var(--tandem-fg-muted);
		cursor: pointer;
		transition: background 0.1s;
	}

	.title-bar-btn:hover {
		background: var(--tandem-surface-muted);
		color: var(--tandem-fg);
	}

	.title-bar-btn:focus-visible {
		outline: 2px solid var(--tandem-accent);
		outline-offset: -2px;
	}

	.title-bar-close:hover {
		background: var(--tandem-error);
		color: var(--tandem-error-fg);
	}

	@media (forced-colors: active) {
		.title-bar {
			background: ButtonFace;
			border-bottom: 1px solid ButtonText;
			forced-color-adjust: auto;
		}

		.title-bar-btn {
			background: ButtonFace;
			color: ButtonText;
			border: none;
		}

		.title-bar-btn:hover {
			background: Highlight;
			color: HighlightText;
		}

		.title-bar-close:hover {
			background: Highlight;
			color: HighlightText;
		}
	}
</style>
