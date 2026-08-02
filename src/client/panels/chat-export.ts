import type { CapturedAnchor, ChatMessage } from "../../shared/types";

export interface ChatExportDocument {
  id: string;
  fileName: string;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19) + "Z";
}

function anchorBlockquote(anchor: CapturedAnchor): string {
  return anchor.textSnapshot
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Deterministic, path-free Markdown representation of the complete conversation. */
export function exportChatMarkdown(
  messages: readonly ChatMessage[],
  openDocs: readonly ChatExportDocument[],
  claudeLabel = "Claude",
): string {
  const fileNames = new Map(
    openDocs.flatMap((doc) => {
      const fileName = doc.fileName.split(/[\\/]/).pop()?.trim();
      return fileName ? [[doc.id, fileName] as const] : [];
    }),
  );
  const sorted = [...messages].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  const lines = ["# Tandem chat export", ""];
  let currentDate = "";

  for (const message of sorted) {
    const date = isoDate(message.timestamp);
    if (date !== currentDate) {
      currentDate = date;
      lines.push(`## ${date}`, "");
    }
    const author =
      message.author === "claude" ? (message.agentIdentity?.displayName ?? claudeLabel) : "You";
    const metadata = [`**${author}**`, isoTime(message.timestamp)];
    const fileName = message.documentId ? fileNames.get(message.documentId) : undefined;
    if (fileName) metadata.push(`\`${fileName.replace(/`/g, "\\`")}\``);
    lines.push(metadata.join(" · "), "");
    if (message.anchor) {
      lines.push(anchorBlockquote(message.anchor), "");
    }
    // Message Markdown is intentionally verbatim. Surrounding blank lines and
    // separators provide structure without re-indenting or escaping the body.
    lines.push(message.text, "", "---", "");
  }

  return lines.join("\n").replace(/(?:---\n\n){2}$/u, "---\n");
}

export function localChatDateLabel(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startToday - startDate) / 86_400_000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}
