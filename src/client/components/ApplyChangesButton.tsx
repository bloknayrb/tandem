import { useState } from "react";
import type { Annotation } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";

interface ApplyChangesButtonProps {
  annotations: Annotation[];
  activeDocFormat: string | undefined;
  documentId: string | undefined;
}

/**
 * Renders a button to apply accepted suggestions as tracked changes in the
 * original .docx file. Only visible for docx-format documents.
 */
export function ApplyChangesButton({
  annotations,
  activeDocFormat,
  documentId,
}: ApplyChangesButtonProps) {
  const [applying, setApplying] = useState(false);

  if (activeDocFormat !== "docx") return null;

  const accepted = annotations.filter((a) => a.status === "accepted");
  const pending = annotations.filter((a) => a.status === "pending");
  const disabled = accepted.length === 0 || applying;

  async function handleClick() {
    if (disabled || !documentId) return;

    let message = `Apply ${accepted.length} change(s) as tracked revisions?\n\nThe changes will appear as tracked revisions in Word \u2014 you can Accept or Reject each one individually.\n\nYour original file will be backed up.`;

    if (pending.length > 0) {
      message += `\n\n\u26A0 ${pending.length} annotation(s) are still pending review and will not be applied.`;
    }

    if (!confirm(message)) return;

    setApplying(true);
    try {
      const res = await fetch(`${API_BASE}/apply-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const body = await res.json().catch(() => null);

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
    } catch {
      alert("Could not reach the server.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <button
      type="button"
      data-testid="apply-changes-btn"
      onClick={handleClick}
      disabled={disabled}
      title={accepted.length === 0 ? "No accepted suggestions to apply" : undefined}
      style={{
        width: "100%",
        padding: "6px 12px",
        fontSize: "12px",
        fontWeight: 500,
        border: "1px solid #bfdbfe",
        borderRadius: "4px",
        background: disabled ? "#f3f4f6" : "#2563eb",
        color: disabled ? "#9ca3af" : "white",
        cursor: disabled ? "default" : "pointer",
        opacity: applying ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {applying ? "Applying\u2026" : `Apply as Tracked Changes (${accepted.length})`}
    </button>
  );
}
