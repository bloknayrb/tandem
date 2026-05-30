<script lang="ts">
import { API_APPLY_CHANGES } from "../../shared/api-paths";
import type { Annotation } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";

interface Props {
  annotations: Annotation[];
  activeDocFormat: string | undefined;
  documentId: string | undefined;
}

let { annotations, activeDocFormat, documentId }: Props = $props();

let applying = $state(false);

const accepted = $derived(annotations.filter((a) => a.status === "accepted"));
const pending = $derived(annotations.filter((a) => a.status === "pending"));
const disabled = $derived(accepted.length === 0 || applying);

async function handleClick() {
  if (disabled || !documentId) return;

  let message = `Apply ${accepted.length} change(s) as tracked revisions?\n\nThe changes will appear as tracked revisions in Word — you can Accept or Reject each one individually.\n\nYour original file will be backed up.`;

  if (pending.length > 0) {
    message += `\n\n⚠ ${pending.length} annotation(s) are still pending review and will not be applied.`;
  }

  if (!confirm(message)) return;

  applying = true;
  try {
    const res = await fetch(`${API_BASE}${API_APPLY_CHANGES}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    });
    const body = await res.json().catch((parseErr: unknown) => {
      console.error("[ApplyChanges] Failed to parse response JSON:", parseErr);
      return null;
    });

    if (!res.ok) {
      alert(body?.message ?? `Apply failed (HTTP ${res.status}).`);
      return;
    }

    const data = body?.data;
    if (data) {
      const parts = [`Applied ${data.applied ?? 0} tracked change(s).`];
      if (data.rejected > 0) {
        parts.push(`${data.rejected} could not be applied.`);
      }
      if (data.backupPath) {
        parts.push(`\nBackup saved to:\n${data.backupPath}`);
      }
      alert(parts.join(" "));
    } else {
      alert("Changes applied successfully.");
    }
  } catch (err) {
    console.error("[ApplyChanges] Request failed:", err);
    alert(
      err instanceof TypeError
        ? "Could not reach the server."
        : `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    applying = false;
  }
}
</script>

{#if activeDocFormat === "docx"}
  <button
    type="button"
    data-testid="apply-changes-btn"
    class="acb-btn"
    class:is-disabled={disabled}
    class:is-applying={applying}
    onclick={handleClick}
    disabled={disabled}
    title={accepted.length === 0 ? "No accepted suggestions to apply" : undefined}
  >
    {applying ? "Applying…" : `Apply as Tracked Changes (${accepted.length})`}
  </button>
{/if}

<style>
  /* Apply-Changes button — info family by design. "Apply as Tracked Changes"
     reads as an informational action (it hands work off to Word's tracked-
     changes UI for explicit Accept/Reject), not a primary commit, so the
     accent-family is intentionally avoided here. */
  .acb-btn {
    width: 100%;
    padding: var(--tandem-space-1) var(--tandem-space-3);
    font-size: var(--tandem-text-xs);
    font-weight: 500;
    border: 1px solid var(--tandem-info-border);
    border-radius: var(--tandem-r-2);
    background: var(--tandem-info);
    color: var(--tandem-info-fg);
    cursor: pointer;
    white-space: nowrap;
    transition: background 140ms ease, color 140ms ease;
  }
  .acb-btn:hover:not(.is-disabled):not(.is-applying) {
    background: var(--tandem-info-fg-strong, var(--tandem-info));
  }
  .acb-btn.is-disabled {
    border-color: var(--tandem-border);
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg-subtle);
    cursor: default;
  }
  .acb-btn.is-applying {
    opacity: 0.6;
  }
  @media (prefers-reduced-motion: reduce) {
    .acb-btn {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .acb-btn {
    transition: none;
  }
</style>
