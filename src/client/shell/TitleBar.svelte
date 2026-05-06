<script lang="ts">
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onDestroy, onMount } from "svelte";

interface Props {
  title?: string;
}
const { title = "Tandem" }: Props = $props();

let isMaximized = $state(false);
let cleanupListeners: (() => void)[] = [];

onMount(async () => {
  if (!isTauriRuntime()) return;
  try {
    const win = getCurrentWindow();
    isMaximized = await win.isMaximized();

    const unlistenResize = await win.onResized(async () => {
      isMaximized = await win.isMaximized();
    });
    const unlistenMove = await win.onMoved(async () => {
      isMaximized = await win.isMaximized();
    });
    cleanupListeners = [unlistenResize, unlistenMove];
  } catch {
    // Non-fatal: title bar degrades gracefully if window API unavailable
  }
});

onDestroy(() => {
  cleanupListeners.forEach((fn) => fn());
});

async function minimize() {
  if (!isTauriRuntime()) return;
  await getCurrentWindow().minimize();
}

async function toggleMaximize() {
  if (!isTauriRuntime()) return;
  await getCurrentWindow().toggleMaximize();
}

async function close() {
  if (!isTauriRuntime()) return;
  await getCurrentWindow().close();
}
</script>

{#if isTauriRuntime()}
	<div class="title-bar" data-tauri-drag-region>
		<div class="title-bar-left" data-tauri-drag-region>
			<span class="title-bar-title" data-tauri-drag-region="false">{title}</span>
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
