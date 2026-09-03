import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Root } from "mdast";
import path from "path";
import * as Y from "yjs";
import { z } from "zod";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_AUTHORSHIP,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { flattenHeadingText, headingPrefix } from "../../shared/offsets.js";
import { withMcp } from "../../shared/origins.js";
import { isPlaintextFormat } from "../../shared/plaintext-format.js";
import type { FlatOffset } from "../../shared/positions/types.js";
import { isTopLevel, sameTextblock } from "../../shared/positions/types.js";
import { elementAtPath, resolveToTextblock } from "../../shared/positions/ydoc.js";
import type { AuthorshipRange, ClaudeAwareness } from "../../shared/types.js";
import { TandemModeSchema, toFlatOffset } from "../../shared/types.js";
import { generateAuthorshipId } from "../../shared/utils.js";
import { isStoreReadOnly } from "../annotations/store.js";
import { type OpenSuccess, openFromDisk, openScratchpad, toWireResult } from "../documents/open.js";
import { getWakeEndpoint } from "../events/wake-socket.js";
import { mdParser } from "../file-io/markdown.js";
import { appendMdast, buildListItemsFromTree } from "../file-io/mdast-ydoc.js";
// Position system
import { anchoredRange, validateRange } from "../positions.js";
import { saveSession } from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { convertToMarkdown } from "./convert.js";
// Document model (pure logic)
import {
  collectBlocks,
  extractText,
  flatDocLength,
  flatOffsetWithinList,
  flatSpanOfChildren,
  getElementText,
  getElementTextLength,
  getHeadingPrefixLength,
  mergeInlineTail,
  replaceFlatRangeInElement,
} from "./document-model.js";
// Document service (state management)
import {
  activateDocument,
  closeDocumentById,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  persistSkippedSaveSession,
  renameDocument,
  requireDocument,
  saveDocumentToDisk,
  toDocListEntry,
} from "./document-service.js";
import { gatedTool, licenseGate } from "./license-gate.js";
import {
  attachItems,
  findListTarget,
  listFormatRefusal,
  removeItemAndCollapse,
} from "./list-edit.js";
import {
  getTextContentOutputShape,
  listDocumentsOutputShape,
  statusOutputShape,
} from "./output-schemas.js";
import { noteClaudeActivity } from "./presence-expiry.js";
import {
  getErrorMessage,
  mcpError,
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
import { withTypingPresence } from "./typing-presence.js";

// ElementPosition re-exported as ResolvedOffset for backward compatibility — prefer ElementPosition.
export type {
  AnchoredRangeResult,
  ElementPosition,
  ElementPosition as ResolvedOffset,
  RangeValidation,
} from "../../shared/positions/index.js";
// Position system re-exports
// resolveToElement re-exported as resolveOffset for backward compatibility — prefer resolveToElement.
export {
  anchoredRange,
  flatOffsetToRelPos,
  refreshAllRanges,
  refreshRange,
  relPosToFlatOffset,
  resolveToElement,
  resolveToElement as resolveOffset,
  validateRange,
} from "../positions.js";
export type { RangeVerifyResult } from "./document-model.js";
// Re-export for backward compatibility with existing consumers.
export {
  collectXmlTexts,
  detectFormat,
  docIdFromPath,
  extractMarkdown,
  extractText,
  findXmlText,
  findXmlTextAtOffset,
  flatDocLength,
  getElementText,
  getElementTextLength,
  getHeadingPrefixLength,
  getOrCreateXmlText,
  mergeXmlTextDelta,
  populateYDoc,
  TEXTBLOCK_NODES,
  verifyAndResolveRange,
} from "./document-model.js";
export type { OpenDoc } from "./document-service.js";
export {
  activateDocument,
  autoSaveAllToDisk,
  closeDocument,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  openDocument,
  requireDocument,
  restoreCtrlSession,
  restoreOpenDocuments,
  saveCurrentSession,
  saveDocumentToDisk,
  toDocListEntry,
  updateDocumentWhenReady,
  writeGenerationId,
} from "./document-service.js";

export interface OutlineEntry {
  level: number;
  text: string;
  index: number;
}

/**
 * The user-facing sentence `tandem_open` returns for a successful open.
 *
 * This used to be an inline `else if` chain over the three result booleans —
 * a **second, independent copy of `kindOfOpenResult`'s precedence** that
 * nothing tied to the first. It now switches on `OpenSuccess["kind"]`, which
 * the pipeline decided at construction, so there is one ordering rather than
 * two that agreed by inspection.
 *
 * **`readOnly` is a fifth distinction the four kinds do not name**, and the
 * old chain reached it only when the other three were false. That is preserved
 * exactly: the `readOnly` split lives under `fresh` alone, so a restored,
 * already-open or force-reloaded document that is ALSO read-only still says
 * nothing about being read only. The switch makes that a visible choice
 * instead of a fall-through consequence, but it is the same behaviour;
 * `tests/server/open-result-message.test.ts` pins all eight
 * `(kind × readOnly)` combinations so the gap stays recorded rather than
 * rediscovered. Changing the wording is a behaviour change and belongs in its
 * own PR.
 *
 * The switch has no `default`. That is deliberate — a fifth arm added to
 * `OpenSuccess` fails to compile here (TS2366, no ending return) rather than
 * silently falling through to a generic sentence. It said `OpenResultKind`
 * until review pointed out that this switches on `OpenSuccess["kind"]` and the
 * two were separate hand-maintained lists, so adding to `OpenResultKind` alone
 * compiled everywhere. `OpenResultKind` is now derived from `OpenSuccess`,
 * which is what makes the sentence true rather than aspirational.
 */
export function openResultMessage(result: OpenSuccess): string {
  switch (result.kind) {
    case "force-reloaded":
      return `Force-reloaded from disk: ${result.fileName}`;
    case "already-open":
      return `Switched to already-open document: ${result.fileName}`;
    case "restored":
      return `Session restored: ${result.fileName} (annotations preserved)`;
    case "fresh":
      return result.readOnly
        ? `Document opened (review only): ${result.fileName}`
        : `Document opened: ${result.fileName}`;
  }
}

/** Extract document outline (headings). Pure logic exported for testing. */
export function getOutline(fragment: Y.XmlFragment): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement && node.nodeName === "heading") {
      const level = Number(node.getAttribute("level") ?? 1);
      // A heading can hold a literal newline since paragraphs gained
      // whitespace:"pre" (#1448) — flatten it so the AI is never handed an
      // outline entry that spans two lines. See flattenHeadingText.
      outline.push({ level, text: flattenHeadingText(getElementText(node)), index: i });
    }
  }
  return outline;
}

/** Extract a section by heading text (case-insensitive). Pure logic exported for testing. */
export function getSection(
  fragment: Y.XmlFragment,
  sectionName: string,
): { found: true; text: string } | { found: false } {
  const lines: string[] = [];
  let inSection = false;
  let sectionLevel = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    // Headings are flattened here for the same reason as in `getOutline`, and
    // the two MUST agree: the AI gets a section name from `tandem_getOutline`
    // and passes it straight back here. If the outline flattened and this
    // comparison did not, a heading holding a newline would be listed under a
    // name that then matched nothing.
    const raw = getElementText(node);
    const text = node.nodeName === "heading" ? flattenHeadingText(raw) : raw;

    if (node.nodeName === "heading") {
      const level = Number(node.getAttribute("level") ?? 1);
      if (inSection && level <= sectionLevel) break;
      if (text.trim().toLowerCase() === sectionName.trim().toLowerCase()) {
        inSection = true;
        sectionLevel = level;
        lines.push(headingPrefix(level) + text);
        continue;
      }
    }

    if (inSection) {
      if (node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        lines.push(headingPrefix(level) + text);
      } else {
        lines.push(text);
      }
    }
  }

  if (!inSection) return { found: false };
  return { found: true, text: lines.join("\n") };
}

/**
 * Stamp Claude authorship across an entire freshly-loaded document.
 *
 * Used by `tandem_open`'s `authoredBy: "claude"` affordance (issue #937): when
 * Claude writes a document wholesale to disk and then opens it, none of the text
 * is attributed to Claude because authorship is otherwise only stamped by
 * `tandem_edit`. This stamps one Claude `AuthorshipRange` per top-level element,
 * each spanning that element's POST-PREFIX text (heading prefixes like `# ` are
 * excluded so the CRDT anchor resolves — `flatOffsetToRelPos(doc, 0)` returns
 * null inside a heading prefix, which would otherwise degrade the whole doc to
 * flat-only).
 *
 * Idempotent via deterministic IDs (`claude-block-{index}`): re-open,
 * session-restore, and force-reload re-`set` the same keys instead of appending
 * duplicates. Never bulk-clears the authorship map, so any browser-added
 * `author:"user"` ranges are preserved (a user can reclaim a block by editing
 * it). Offsets mirror `extractText`'s top-level walk: top-level elements joined
 * by FLAT_SEPARATOR (1 char), each element offset by its heading prefix.
 *
 * `startIndex` (default 0) restricts stamping to top-level blocks at or after
 * that fragment index — used by `tandem_appendContent` to stamp only the
 * freshly-appended blocks while leaving earlier (possibly user-authored) blocks
 * untouched. The `flatCursor` still advances across the skipped earlier blocks
 * so the stamped ranges keep their ABSOLUTE flat offsets (anchoring against the
 * top of the doc would silently mis-attribute existing text).
 */
export function stampClaudeAuthorshipWholeDoc(doc: Y.Doc, startIndex = 0): void {
  const fragment = doc.getXmlFragment("default");
  const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
  const timestamp = Date.now();
  const entries: Array<{ key: string; entry: AuthorshipRange }> = [];

  let flatCursor = 0;
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
    const textLen = getElementTextLength(node);
    const from = flatCursor + prefixLen;
    const to = from + textLen;

    // Advance the cursor past this element (prefix + text) plus the
    // FLAT_SEPARATOR that joins top-level elements. Runs for EVERY block,
    // including those before startIndex, so offsets stay absolute.
    flatCursor = to + 1;

    // Append-stamping: skip blocks before startIndex (already stamped /
    // user-authored). The cursor advance above already ran for them.
    if (i < startIndex) continue;

    // Skip zero-width spans (empty paragraphs, bare headings) —
    // resolveAuthorshipRange rejects them anyway.
    if (from >= to) continue;

    const anchored = anchoredRange(doc, toFlatOffset(from), toFlatOffset(to));
    if (!anchored.ok) continue;

    // Key on the fragment element index (not a running stamped-block counter)
    // so IDs stay stable across re-opens even when some blocks are skipped.
    const key = `claude-block-${i}`;
    entries.push({
      key,
      entry: {
        id: key,
        author: "claude",
        range: anchored.range,
        relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
        timestamp,
      },
    });
  }

  if (entries.length === 0) return;

  // Split siblings must go before the base key is re-set, or idempotency is
  // only half true. The client splits an entry an insertion landed inside
  // (#1471 gap 3) into `{id}`, `{id}#1`, `{id}#2` — the derived ids exist so
  // this re-stamp can find the family it no longer fully owns. Re-setting
  // `claude-block-3` alone would restore the whole-block range on top of
  // pieces that are still there, painting the same characters twice and
  // silently undoing the split on every re-open. Durably, since the authorship
  // map is persisted wholesale into the session file.
  //
  // Prefix, not exact `#{n}`: a piece that was itself split again is
  // `claude-block-3#1#2`, and it belongs to the same family.
  const staleSiblings = [...authorshipMap.keys()].filter((key) =>
    entries.some(({ key: base }) => key.startsWith(`${base}#`)),
  );

  withMcp(doc, () => {
    for (const key of staleSiblings) authorshipMap.delete(key);
    for (const { key, entry } of entries) {
      authorshipMap.set(key, entry);
    }
  });
}

/**
 * Anchor a flat range and record it as Claude-authored, in one place.
 *
 * Both `tandem_edit` and `tandem_editList` need this, and the entry shape — in
 * particular `relRange` being present only when the anchor is FULL — is the kind
 * of detail that goes quietly wrong when it is written twice.
 *
 * Deliberately not `stampClaudeAuthorshipWholeDoc`: that walks top level only,
 * keys entries `claude-block-${i}` by fragment index and has no end bound, so a
 * mid-document write would re-key every later block.
 */
function stampClaudeRange(doc: Y.Doc, from: FlatOffset, to: FlatOffset): void {
  if (to <= from) return;
  const anchored = anchoredRange(doc, from, to);
  if (!anchored.ok) return;
  const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
  const rangeId = generateAuthorshipId("claude");
  withMcp(doc, () => {
    authorshipMap.set(rangeId, {
      id: rangeId,
      author: "claude",
      range: anchored.range,
      relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
      timestamp: Date.now(),
    } satisfies AuthorshipRange);
  });
}

export function registerDocumentTools(server: McpServer): void {
  const openDocs = getOpenDocs();

  server.tool(
    "tandem_open",
    "Open a file in the Tandem editor; returns a documentId. Auto-opens the editor. force=true reloads from disk if the file changed externally.",
    {
      filePath: z.string().describe("Absolute path to the file to open"),
      force: z
        .boolean()
        .optional()
        .describe("Force reload from disk even if already open. Clears annotations and session."),
      authoredBy: z
        .literal("claude")
        .optional()
        .describe(
          "Pass 'claude' when you wrote this file wholesale before opening, to stamp Claude authorship across its content. Idempotent.",
        ),
    },
    withErrorBoundary("tandem_open", async ({ filePath, force, authoredBy }) => {
      // License gate (#1116) — ONLY the destructive force-reload sub-path. Plain
      // open stays ungated (the read/export escape hatch), but force=true runs
      // clearAndReload, which wipes the durable annotation file — an editing-class
      // operation a restricted user must not reach. Gate sits OUTSIDE the inner
      // try so a (post-flip) open throw keeps its own error categorization.
      if (force === true) {
        const blocked = licenseGate();
        if (blocked) return blocked;
      }
      try {
        const result = await openFromDisk(filePath, { force });

        // Issue #937: attribute Claude-authored documents at creation. Stamp
        // AFTER openFromDisk resolves — content is guaranteed populated, and
        // the durable-sync/channel observers attach later in wireAnnotationStore,
        // so there is no race. Upload/scratchpad paths bypass openFromDisk and
        // are naturally excluded.
        if (authoredBy === "claude") {
          const loaded = requireDocument(result.documentId);
          if (loaded) {
            stampClaudeAuthorshipWholeDoc(loaded.doc);
          }
        }
        return mcpSuccess({ ...toWireResult(result), message: openResultMessage(result) });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT" || e.code === "FILE_NOT_FOUND") {
          return mcpError("FILE_NOT_FOUND", e.message);
        }
        if (e.code === "INVALID_PATH") {
          return mcpError("FILE_NOT_FOUND", e.message);
        }
        if (e.code === "UNSUPPORTED_FORMAT" || e.code === "FILE_TOO_LARGE") {
          return mcpError("FORMAT_ERROR", e.message);
        }
        if (e.code === "EBUSY" || e.code === "EPERM") {
          return mcpError(
            "FILE_LOCKED",
            `File is locked — another program (likely Microsoft Word) has it open. Close it and try again.`,
          );
        }
        if (e.code === "EACCES") {
          return mcpError("PERMISSION_DENIED", e.message);
        }
        return mcpError("FORMAT_ERROR", getErrorMessage(err));
      }
    }),
  );

  server.tool(
    "tandem_scratchpad",
    "Open a new ephemeral Scratchpad tab for drafting — never touches the filesystem; content is lost when the tab closes. Optionally seed with markdown.",
    {
      content: z
        .string()
        .optional()
        .describe(
          "Initial markdown. Block structure (headings, lists, blank-line-separated paragraphs) is parsed into real blocks.",
        ),
    },
    gatedTool("tandem_scratchpad", async ({ content }) => {
      const result = await openScratchpad(content);
      return mcpSuccess({
        documentId: result.documentId,
        fileName: result.fileName,
        format: result.format,
      });
    }),
  );

  server.registerTool(
    "tandem_getTextContent",
    {
      description:
        "Read document as plain text whose offsets match the annotation coordinate system.",
      inputSchema: {
        section: z.string().optional().describe("Optional heading text to read only that section"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID (defaults to active document)"),
      },
      outputSchema: getTextContentOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_getTextContent", async ({ section, documentId }) => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        if (section) {
          const fragment = r.doc.getXmlFragment("default");
          const result = getSection(fragment, section);
          if (!result.found) {
            return mcpError("INVALID_RANGE", `Section "${section}" not found in document.`);
          }
          return mcpStructured({ text: result.text, filePath: r.filePath, section });
        }

        // Always use extractText — its offsets match validateRange/anchoredRange.
        // extractMarkdown adds markdown syntax (e.g. `> ` for blockquotes) that
        // shifts offsets, causing RANGE_MOVED errors in annotation tools.
        const text = extractText(r.doc);
        return mcpStructured({ text, filePath: r.filePath, documentId: r.docId });
      }),
    ),
  );

  server.tool(
    "tandem_getOutline",
    "Get document structure without full content. Headings only by default (low token cost); " +
      "pass includeBlocks to also list every block — paragraphs, list items, their nesting and " +
      "checkbox state — with the character offsets tandem_edit takes.",
    {
      includeBlocks: z
        .boolean()
        .optional()
        .describe(
          "Also return every block, not just headings: node type, flat [from,to) range, nesting " +
            "path, position within its list, and checkbox state. Flat text alone cannot show " +
            "this — a list item reads as bare prose — so pass this before editing inside a list " +
            "or a table. Roughly one entry per block; omit on large documents.",
        ),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getOutline", async ({ includeBlocks, documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment("default");
      const outline = getOutline(fragment);
      // Opt-in: the outline is the documented cheap read, and `blocks` is
      // roughly one entry per block. Lives here rather than on
      // `tandem_getTextContent` because that tool carries an `outputSchema`
      // (so an unlisted container node would fail validation on a real
      // document) and its `section` branch returns early, which would make
      // structure unobtainable for a section read.
      return mcpSuccess({
        outline,
        totalNodes: fragment.length,
        ...(includeBlocks ? { blocks: collectBlocks(r.doc) } : {}),
      });
    }),
  );

  server.tool(
    "tandem_edit",
    "Edit text in the document at a specific range. For single-paragraph replacements only — newlines in newText are inserted as literal text.",
    {
      from: z.number().describe("Start position (character offset)"),
      to: z.number().describe("End position (character offset)"),
      newText: z.string().describe("Replacement text (single paragraph — no newlines)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    gatedTool(
      "tandem_edit",
      async ({ from: rawFrom, to: rawTo, newText, documentId, textSnapshot }) => {
        // #651 presence: tandem_edit targets text (not an annotation), so the
        // marker is the generic status-bar "Claude is working" indicator.
        return withTypingPresence({ tool: "tandem_edit", documentId }, async () => {
          const r = requireDocument(documentId);
          if (!r) return noDocumentError();

          const docState = getCurrentDoc(documentId);
          if (docState?.readOnly) {
            return mcpError(
              "FORMAT_ERROR",
              "Document is read-only (.docx). Use annotations instead.",
            );
          }

          // #1460: enforce what this tool's own description has always claimed.
          //
          // "newlines in newText are inserted as literal text" is accurate, and
          // in a markdown document it is also harmless — a literal `\n` is a soft
          // wrap the serializer can spell, which is what `whitespace: "pre"`
          // (#1448) exists to preserve. In a PLAINTEXT document it is a shape the
          // file cannot store: save joins blocks with `\n`, so the bytes say two
          // lines while the model says one block, and the next open believes the
          // bytes. The AI's one-paragraph edit reopens as two.
          //
          // Refusing rather than splitting, deliberately. This tool is documented
          // and shaped as a single-paragraph replacement — every offset it
          // returns, and `RANGE_MOVED`'s retry contract, assume the edit stays
          // inside one textblock. Silently promoting it to a multi-block insert
          // would change that contract for every caller to fix a case the caller
          // can trivially avoid, and the error names the fix.
          if (isPlaintextFormat(docState?.format) && /[\r\n]/.test(newText)) {
            return mcpError(
              "INVALID_ARGUMENT",
              `Cannot insert a newline into a '${docState?.format}' document: plaintext formats ` +
                "cannot represent a line break inside a paragraph, so it would reopen as " +
                "separate paragraphs. Issue one tandem_edit per line instead.",
            );
          }

          // An empty document has no addressable range — resolveToElement returns
          // null on a zero-length fragment, which would otherwise surface as a
          // confusing generic INVALID_RANGE. Point the agent at the seeding path.
          if (r.doc.getXmlFragment("default").length === 0) {
            return mcpError(
              "EMPTY_DOCUMENT",
              "Document is empty — no text range to edit. Seed content with tandem_appendContent({ content }) or tandem_scratchpad({ content }).",
            );
          }

          const from = toFlatOffset(rawFrom);
          const to = toFlatOffset(rawTo);
          const v = validateRange(r.doc, from, to, {
            textSnapshot,
            rejectHeadingOverlap: true,
          });
          if (!v.ok) {
            if (v.code === "RANGE_GONE") {
              return mcpError("RANGE_GONE", "Target text no longer exists in the document.");
            }
            if (v.code === "RANGE_MOVED") {
              return mcpError(
                "RANGE_MOVED",
                "Target text has moved. Use resolvedFrom/resolvedTo to retry.",
                { resolvedFrom: v.resolvedFrom, resolvedTo: v.resolvedTo },
              );
            }
            if (v.code === "HEADING_OVERLAP") {
              return mcpError(
                "INVALID_RANGE",
                'Edit range overlaps with heading markup (e.g., "## "). Target the text content only. ' +
                  "Use tandem_resolveRange to find the text position.",
              );
            }
            return mcpError("INVALID_RANGE", v.message);
          }

          const fragment = r.doc.getXmlFragment("default");
          // Resolve to the TEXTBLOCK that owns each offset, at any depth. The old
          // `resolveToElement` pair stopped at the fragment's direct children, so
          // every offset inside a list resolved to the `bulletList` CONTAINER and
          // was rejected with "edit a specific paragraph or list item instead" —
          // advice no tool could follow, because none could address a nested block.
          const startPos = resolveToTextblock(fragment, from);
          const endPos = resolveToTextblock(fragment, to);

          if (!startPos || !endPos) {
            return mcpError(
              "INVALID_RANGE",
              `Cannot resolve offset range [${from}, ${to}] to editable text. The range may cover only a container or an image.`,
            );
          }

          const startNode = elementAtPath(fragment, startPos.path);
          const endNode = elementAtPath(fragment, endPos.path);
          if (!startNode || !endNode) {
            return mcpError(
              "INVALID_RANGE",
              `Cannot resolve offset range [${from}, ${to}] in document.`,
            );
          }

          // Every rejection below MUST precede the first `withMcp` — Y.js does not
          // roll back a transaction on throw, so a late bail is a partial commit.
          if (sameTextblock(startPos, endPos)) {
            // Same textblock at any depth: a list item, a nested item, a table
            // cell, a blockquote paragraph. `replaceFlatRangeInElement` already
            // handles multi-XmlText/hardBreak interiors, so depth costs nothing.
            withMcp(r.doc, () => {
              replaceFlatRangeInElement(startNode, startPos.textOffset, endPos.textOffset, newText);
            });
          } else if (!isTopLevel(startPos) || !isTopLevel(endPos)) {
            // Cross-block where either end is nested. The top-level algorithm below
            // is keyed on `fragment.delete` indices and cannot express "delete the
            // middle items of this list", so refuse rather than corrupt — and name
            // both retry ranges so the caller's next call is mechanical.
            //
            // NB: the test is `isTopLevel` on BOTH ends plus `sameTextblock` above, never
            // top-level-index equality. Two different list items share a top-level
            // index, so an index test reads a cross-item range as same-block and
            // edits with offsets measured against two different elements.
            const startEnd = toFlatOffset(
              from + (getElementTextLength(startNode) - startPos.textOffset),
            );
            const endStart = toFlatOffset(to - endPos.textOffset);
            return mcpError(
              "INVALID_RANGE",
              `Range [${from}, ${to}] spans two blocks and at least one is nested (inside a list, ` +
                `blockquote or table). tandem_edit replaces text within a single block. Edit them ` +
                `separately — the first ends at ${startEnd}, the second starts at ${endStart} — or ` +
                `use tandem_appendContent for new block structure.`,
            );
          } else {
            const startIndex = startPos.path[0];
            const endIndex = endPos.path[0];
            withMcp(r.doc, () => {
              // Cross-element edit, both ends top-level. Each textblock may hold
              // multiple Y.XmlText children split by sibling hardBreaks, so
              // trims/merges go through the multi-XmlText helpers — the old
              // first-XmlText-only path dropped the tail's breaks and later runs.
              // 1. Trim the start element's tail: delete [startOffset, end).
              replaceFlatRangeInElement(
                startNode,
                startPos.textOffset,
                getElementTextLength(startNode),
                "",
              );

              // 2. Delete the whole in-between elements.
              // One call, not a loop: Y.XmlFragment.delete takes a length.
              const deleteCount = endIndex - startIndex - 1;
              if (deleteCount > 0) fragment.delete(startIndex + 1, deleteCount);

              // 3. Trim the end element's head: delete [0, endOffset).
              const tailNode = fragment.get(startIndex + 1) as Y.XmlElement;
              replaceFlatRangeInElement(tailNode, 0, endPos.textOffset, "");

              // 4. Insert newText at the join (end of start), then fold the end
              //    element's surviving children onto start → [start][newText][end].
              //    Step 1 trimmed start down to [0, startOffset), and steps 2-3 don't
              //    touch it, so its flat length is exactly startPos.textOffset — no
              //    need to re-walk it.
              if (newText.length > 0) {
                const joinAt = startPos.textOffset;
                replaceFlatRangeInElement(startNode, joinAt, joinAt, newText);
              }
              mergeInlineTail(startNode, tailNode);

              // 5. Remove the now-emptied end element.
              fragment.delete(startIndex + 1, 1);
            });
          }

          // Record authorship for the inserted text (Y.Map overlay strategy).
          // This runs in a separate transaction because anchoredRange() reads the
          // Y.Doc state *after* the edit to compute RelativePositions for the new
          // text. Combining it into the edit transaction would anchor against
          // pre-edit state.
          //
          // The split opens no race: `anchoredRange` is synchronous and nothing
          // between the two `withMcp` calls awaits, so Node cannot interleave a
          // remote Y update into the gap. Adding an `await` in this span would
          // create one.
          if (newText.length > 0) {
            stampClaudeRange(r.doc, from, toFlatOffset(from + newText.length));
          }

          return mcpSuccess({ edited: true, from, to, newTextLength: newText.length });
        });
      },
    ),
  );

  // 1 MB inline cap — mdParser.parse is synchronous and blocks the event loop;
  // the 50 MB file cap is far too loose for an inline MCP argument.
  const MAX_APPEND_CONTENT_BYTES = 1_000_000;

  server.tool(
    "tandem_editList",
    "Change the SHAPE of a list: add an item, remove one, or tick a checkbox. Does not change " +
      "the wording of an item — use tandem_edit for that. Target an item by a flat offset " +
      "anywhere inside it; call tandem_getOutline({ includeBlocks: true }) to see the list's " +
      "items and their offsets. Markdown and .docx documents only.",
    {
      at: z
        .number()
        .describe(
          "A flat character offset anywhere inside the target list item. Take it from a blocks[] " +
            "entry in tandem_getOutline({ includeBlocks: true }) — do not reuse one from before " +
            "your last edit.",
        ),
      op: z
        .enum(["insertAfter", "insertBefore", "remove", "setChecked"])
        .describe(
          "insertAfter / insertBefore add new item(s) next to the target and need `markdown`. " +
            "remove deletes the target item and everything nested under it. setChecked ticks or " +
            "unticks its checkbox and needs `checked`. There is no move op: reordering by " +
            "composing remove + insertAfter loses the item's annotations and authorship, " +
            "because Yjs cannot move a node and the rebuild drops its anchors.",
        ),
      markdown: z
        .string()
        .optional()
        .describe(
          "insertAfter / insertBefore only. One item per line as markdown (`- text`); indent two " +
            "spaces to nest under the line above. A block that is not a list item is wrapped as " +
            "one. Only the NEW items — never re-send the text of the item you are targeting, " +
            "which is left untouched.",
        ),
      checked: z
        .union([z.boolean(), z.null()])
        .optional()
        .describe(
          "setChecked only. true ticks the box, false unticks it, null removes the checkbox and " +
            "leaves an ordinary bullet. Markdown only — Word lists have no checkbox state.",
        ),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    gatedTool("tandem_editList", async ({ at, op, markdown, checked, documentId }) => {
      return withTypingPresence({ tool: "tandem_editList", documentId }, async () => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        const docState = getCurrentDoc(documentId);
        if (docState?.readOnly) {
          return mcpError("FORMAT_ERROR", "Document is read-only — cannot edit lists.");
        }
        const refusal = listFormatRefusal(docState?.format);
        if (refusal) return mcpError("FORMAT_ERROR", refusal);

        const fragment = r.doc.getXmlFragment("default");
        if (fragment.length === 0) {
          return mcpError(
            "EMPTY_DOCUMENT",
            "Document is empty — no list to edit. Seed content with tandem_appendContent.",
          );
        }

        // Bounds-check BEFORE resolving. `resolveToElement` clamps out-of-range
        // offsets to the first/last element, so an `at` past the end silently
        // targets the LAST item and one below zero targets the FIRST — and
        // `op: "remove"` would then delete an item the caller never named and
        // report success. A stale offset is exactly the case this tool's own
        // description warns about, so it must fail loudly rather than guess.
        const flatLength = flatDocLength(r.doc);
        if (!Number.isInteger(at) || at < 0 || at > flatLength) {
          return mcpError(
            "INVALID_RANGE",
            `Offset ${at} is outside the document (0..${flatLength}). Re-read the list with ` +
              "tandem_getOutline({ includeBlocks: true }) — an offset from before your last " +
              "edit may no longer point where you expect.",
          );
        }
        const pos = resolveToTextblock(fragment, toFlatOffset(at));
        if (!pos) {
          return mcpError("INVALID_RANGE", `Cannot resolve offset ${at} to a block.`);
        }
        const target = findListTarget(fragment, pos.path);
        if ("error" in target) return mcpError("INVALID_RANGE", target.error);

        // Everything that can refuse must refuse BEFORE the transaction — Y.js
        // does not roll back on throw, so a late bail is a partial commit.
        if (op === "setChecked") {
          if (checked === undefined) {
            return mcpError(
              "INVALID_ARGUMENT",
              "setChecked requires `checked` (true, false or null).",
            );
          }
          if (docState?.format === "docx") {
            return mcpError(
              "FORMAT_ERROR",
              "Word lists have no checkbox state, so setChecked does not apply to a .docx. " +
                "The other ops work on this document.",
            );
          }
          withMcp(r.doc, () => {
            if (checked === null) target.item.removeAttribute("checked");
            // Stored as a real boolean, matching what y-prosemirror writes when a
            // user toggles the checkbox, so it round-trips byte-identically.
            else target.item.setAttribute("checked", checked as any);
          });
          return mcpSuccess({ edited: true, op, itemIndex: target.index + 1, checked });
        }

        if (op === "remove") {
          withMcp(r.doc, () => removeItemAndCollapse(fragment, target));
          return mcpSuccess({ edited: true, op, removedItemIndex: target.index + 1 });
        }

        // insertAfter / insertBefore
        if (!markdown || markdown.trim() === "") {
          return mcpError("INVALID_ARGUMENT", `${op} requires \`markdown\` for the new item(s).`);
        }
        if (Buffer.byteLength(markdown, "utf-8") > MAX_APPEND_CONTENT_BYTES) {
          return mcpError(
            "FILE_TOO_LARGE",
            `markdown exceeds the ${MAX_APPEND_CONTENT_BYTES}-byte limit.`,
          );
        }

        // Parse AND build outside the transaction. Parsing alone is not enough:
        // `blockToYxml`'s default arm calls the remark stringifier, so a throw
        // during the build would land mid-transaction with the delete already
        // applied and nothing replacing it.
        const tree = mdParser.parse(markdown) as Root;
        const { items, deferred } = buildListItemsFromTree(tree);
        if (items.length === 0) {
          return mcpError("INVALID_ARGUMENT", "markdown parsed to no list items.");
        }

        const insertAt = op === "insertAfter" ? target.index + 1 : target.index;
        withMcp(r.doc, () => attachItems(target.list, insertAt, items, deferred));

        // Stamp the inserted items as Claude's, using the per-range scheme
        // tandem_edit uses. `stampClaudeAuthorshipWholeDoc` is unusable here: it
        // walks top level only, keys entries by fragment index, and has no end
        // bound, so a mid-document insert would re-key every later block.
        //
        // The range is derived from the document AFTER insertion rather than
        // from the target block's own start. Deriving it from the target stamps
        // the user's existing item — `insertAfter` puts the new items after it,
        // so a span starting at the target covers text Claude did not write, and
        // claiming authorship over the user's prose is worse than claiming none.
        // Scoped to the target list, not the document: the span is a question
        // about `target.list`'s children, and enumerating every block in the
        // file to answer it costs a full traversal plus an allocation per block
        // (1041 of them on this repo's CHANGELOG) — on the long lists this tool
        // exists for, that dominates the mutation itself.
        const listStart = at - pos.textOffset - flatOffsetWithinList(target.list, target.index);
        const insertedSpan = flatSpanOfChildren(target.list, insertAt, items.length, listStart);
        if (insertedSpan) {
          stampClaudeRange(r.doc, toFlatOffset(insertedSpan.from), toFlatOffset(insertedSpan.to));
        }

        return mcpSuccess({
          edited: true,
          op,
          insertedCount: items.length,
          atItemIndex: insertAt + 1,
        });
      });
    }),
  );

  server.tool(
    "tandem_appendContent",
    "Append markdown to the END of the document, parsing headings/lists/paragraphs into real blocks (unlike tandem_edit, which is single-paragraph with literal newlines). Non-destructive; also seeds an empty document. Markdown documents only.",
    {
      content: z
        .string()
        .describe("Markdown to append. Block structure is parsed into real blocks."),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    gatedTool("tandem_appendContent", async ({ content, documentId }) => {
      return withTypingPresence({ tool: "tandem_appendContent", documentId }, async () => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        const docState = getCurrentDoc(documentId);
        if (docState?.readOnly) {
          return mcpError("FORMAT_ERROR", "Document is read-only (.docx) — cannot append content.");
        }
        if (docState && docState.format !== "md") {
          return mcpError("FORMAT_ERROR", "tandem_appendContent supports markdown documents only.");
        }
        if (Buffer.byteLength(content, "utf-8") > MAX_APPEND_CONTENT_BYTES) {
          return mcpError(
            "FILE_TOO_LARGE",
            `Content exceeds the ${MAX_APPEND_CONTENT_BYTES}-byte append limit.`,
          );
        }

        // Parse outside the transaction to shrink the in-transact failure surface
        // (mirrors the adapter parse/apply split). Cast: mdParser.parse is typed Node.
        const tree = mdParser.parse(content) as Root;

        const fragment = r.doc.getXmlFragment("default");
        const fragBefore = fragment.length;
        withMcp(r.doc, () => appendMdast(r.doc, tree));
        const fragAfter = fragment.length;

        // Stamp only the freshly-appended top-level blocks as Claude authorship,
        // mirroring tandem_edit's automatic stamp of inserted text. Skip the
        // whole-fragment walk when nothing was appended (e.g. whitespace-only).
        if (fragAfter > fragBefore) {
          stampClaudeAuthorshipWholeDoc(r.doc, fragBefore);
        }

        return mcpSuccess({
          appended: true,
          // Fragment-element delta, not an mdast-paragraph count: splitParagraphImages
          // can emit multiple elements from one paragraph, so this may exceed the
          // number of source markdown paragraphs.
          blockCount: fragAfter - fragBefore,
        });
      });
    }),
  );

  server.tool(
    "tandem_save",
    "Save the current document back to disk",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_save", async ({ documentId }) => {
      // path.basename eliminates directory components so CodeQL does not trace
      // user input through Map.get(id) to existing.filePath (js/path-injection).
      const safeDocId = documentId !== undefined ? path.basename(documentId) : undefined;
      const r = requireDocument(safeDocId);
      if (!r) return noDocumentError();

      const docState = getCurrentDoc(safeDocId);
      const format = docState?.format ?? "txt";
      const readOnly = docState?.readOnly ?? false;

      // Uploaded files have no disk path — session-only save
      if (docState?.source === "upload") {
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message:
            "Session saved (annotations preserved). This file was uploaded — no disk path to save to.",
        });
      }

      // Read-only documents (e.g. CHANGELOG, uploads) — session-only save.
      // .docx is no longer read-only (#576); it round-trips through the binary
      // save branch below.
      if (readOnly) {
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message:
            "Session saved (annotations preserved). Source file unchanged — document is read-only.",
        });
      }

      // Delegate to shared save function (handles .docx body export back to disk)
      const result = await saveDocumentToDisk(r.docId, "mcp");
      if (result.status === "saved") {
        // Surface .docx body-export fidelity warnings (#576) so the agent knows
        // what the round-trip downgraded (e.g. unsupported blocks → plain text).
        return mcpSuccess({
          saved: true,
          filePath: r.filePath,
          ...(result.fidelityWarnings && result.fidelityWarnings.length > 0
            ? { fidelityWarnings: result.fidelityWarnings }
            : {}),
          // Post-write verification advisories (#1123 0e). Content-free strings;
          // surfaced so the agent knows the save may have lost content
          // unexpectedly (the user's original is backed up). A `blocked` verdict
          // never reaches here — it aborts the save (result.status === "error").
          ...(result.integrityWarnings && result.integrityWarnings.length > 0
            ? { integrityWarnings: result.integrityWarnings }
            : {}),
          // How many KINDS of Word feature the import couldn't bring in (#1142
          // G3) — so the agent knows this save overwrote an original that had
          // things the model never held. A capped category count, NOT a feature
          // count, and the lines themselves stay user-only (see the note in
          // docx-lost-features.ts on why import losses don't cross to Claude).
          ...(result.unpreservedImports ? { unpreservedImports: result.unpreservedImports } : {}),
        });
      }
      if (result.status === "skipped") {
        // Fall back to session-only save for skipped formats. The disk save
        // did NOT happen, so persist the dirty flag (#1069) and any pending
        // conflict (#1238): without them a skipped save would write a
        // clean-looking session that a restart then discards — losing the only
        // copy of the unsaved edits, or silently laundering away a conflict the
        // user still has to decide.
        await persistSkippedSaveSession(r.docId);
        // An external-conflict skip is not a save at any level Claude can act
        // on, and `saved: true` would be a lie it has no way to check. Report
        // it as an error instead — the resolution is a human keep-vs-reload
        // choice in the editor, which no MCP tool exposes. Ordering matters:
        // the session write above must happen first, or the carry is dead code.
        //
        // Branches on `skipCode`, not `reason`: `reason` is free-form prose
        // (SaveResult's own contract says as much) and `skipCode` is the
        // machine-readable discriminator added specifically so callers don't
        // depend on exact wording (review finding — this branch had drifted
        // to the string it was meant to avoid).
        if (result.skipCode === "EXTERNAL_CONFLICT") {
          // Name the document — with several open, "a conflict" isn't
          // actionable — and name BOTH exits. The banner is the normal one, but
          // it needs a browser/desktop client; in stdio there is none, and
          // pointing only at it would describe a remedy the caller cannot
          // reach. tandem_open force:true works in either mode.
          return mcpError(
            "EXTERNAL_CONFLICT",
            `${r.filePath} changed on disk while it had unsaved edits. The session was saved, but the disk save was blocked. The user resolves this with Keep or Reload in the editor's banner; if no editor is attached, tandem_open with force: true reloads from disk and discards the unsaved edits (and annotations).`,
            { documentId: r.docId, filePath: r.filePath },
          );
        }
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message: `Session saved. Disk save skipped: ${result.reason}`,
        });
      }
      // result.status === "error"
      if (result.errorCode === "EACCES" || result.errorCode === "EPERM") {
        return mcpError("FILE_LOCKED", result.reason ?? "Save failed");
      }
      return mcpError("FORMAT_ERROR", result.reason ?? "Save failed");
    }),
  );

  server.registerTool(
    "tandem_status",
    {
      description:
        "Read editor status (no params) or set your visible status text (pass text), shown in the editor's status bar.",
      inputSchema: {
        text: z.string().optional().describe("Status text to display — omit for read-only"),
        focusParagraph: z
          .number()
          .optional()
          .describe("Index of paragraph the AI is focusing on (write mode only)"),
        focusOffset: z
          .number()
          .optional()
          .describe("Flat character offset for precise cursor positioning (write mode only)"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID for status write (defaults to active document)"),
      },
      outputSchema: statusOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary(
        "tandem_status",
        async ({ text, focusParagraph, focusOffset, documentId }) => {
          // Write mode — update Claude's status shown in the editor
          if (text !== undefined) {
            const current = getCurrentDoc(documentId);
            if (!current) {
              return mcpStructured({
                status: text,
                warning: "No document open — status not broadcast to editor.",
              });
            }
            const doc = getOrCreateDocument(current.docName);
            const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
            withMcp(doc, () => {
              // #651: preserve the in-flight `working` marker so a status
              // update during a wrapped tool call (tandem_comment / _edit /
              // _reply / _annotationReply) doesn't wipe the typing indicator.
              const prev = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
              awarenessMap.set(Y_MAP_CLAUDE, {
                status: text,
                timestamp: Date.now(),
                active: true,
                focusParagraph: focusParagraph ?? null,
                focusOffset: focusOffset ?? null,
                ...(prev?.working ? { working: prev.working } : {}),
              });
            });
            // This write claims `active: true` and nothing here can ever clear it
            // — arm the expiry sweep so the claim has a bounded lifetime.
            noteClaudeActivity(current.docName);
            return mcpStructured({ status: text });
          }

          // Read mode — return editor status summary
          const activeId = getActiveDocId();
          const active = activeId ? openDocs.get(activeId) : null;

          const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
          const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
          const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(
            ctrlAwareness.get(Y_MAP_MODE),
          );

          // Reported rather than hardcoded in SKILL.md, because a wake URL that
          // names the wrong port fails SILENTLY — the model opens a socket to
          // whatever unrelated service holds 3479 and believes it is armed.
          // Absent (not a guess) when no wake transport is running: stdio mode
          // has no HTTP server to attach one to.
          const wakeUrl = getWakeEndpoint();

          return mcpStructured({
            running: true,
            mode,
            storeReadOnly: isStoreReadOnly(),
            ...(wakeUrl ? { wakeUrl } : {}),
            activeDocument: active
              ? { documentId: active.id, filePath: active.filePath, format: active.format }
              : null,
            openDocuments: Array.from(openDocs.values()).map((d) => ({
              documentId: d.id,
              filePath: d.filePath,
              format: d.format,
              readOnly: d.readOnly,
            })),
            documentCount: docCount(),
          });
        },
      ),
    ),
  );

  server.tool(
    "tandem_close",
    "Close a document. Closes the active document if no documentId specified.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Document ID to close (defaults to active document)"),
    },
    withErrorBoundary("tandem_close", async ({ documentId }) => {
      // path.basename eliminates directory components — CodeQL taint-terminator
      // before documentId reaches closeDocumentById's Map.get/FS sinks.
      const rawId = documentId ?? getActiveDocId();
      if (!rawId) return mcpError("NO_DOCUMENT", "No document to close.");
      const id = path.basename(rawId);

      const result = await closeDocumentById(id);
      if (!result.success) return mcpError("NO_DOCUMENT", result.error);

      return mcpSuccess({
        closed: true,
        was: result.closedPath,
        activeDocumentId: result.activeDocumentId,
      });
    }),
  );

  server.tool(
    "tandem_rename",
    "Rename an open on-disk file (same directory, same extension); document stays open with annotations intact. Not for scratchpads/uploads or read-only files.",
    {
      newName: z
        .string()
        .describe("New file name (basename only, e.g. 'notes.md' — must keep the same extension)"),
      documentId: z
        .string()
        .optional()
        .describe("Document ID to rename (defaults to active document)"),
    },
    withErrorBoundary("tandem_rename", async ({ newName: rawNewName, documentId: rawDocId }) => {
      const rawId = rawDocId ?? getActiveDocId();
      if (!rawId) return mcpError("NO_DOCUMENT", "No document to rename.");
      // Sanitize via path.basename() — CodeQL's recognized taint-terminator for
      // js/path-injection. Both values are hashes or basenames (no separators on
      // valid input); the calls break the taint chain before reaching fs sinks.
      const id = path.basename(rawId);
      if (!id) return mcpError("BAD_REQUEST", "documentId resolved to an empty string.");
      const newName = path.basename(rawNewName);
      if (!newName) return mcpError("INVALID_NAME", "newName must not be empty.");

      const result = await renameDocument(id, newName);
      if (result.status === "error") {
        return mcpError(result.errorCode ?? "RENAME_FAILED", result.reason ?? "Rename failed.");
      }

      return mcpSuccess({
        renamed: true,
        from: result.oldPath,
        to: result.newPath,
        fileName: result.fileName,
      });
    }),
  );

  server.registerTool(
    "tandem_listDocuments",
    {
      description: "List all open documents with their IDs, file paths, and formats.",
      inputSchema: {},
      outputSchema: listDocumentsOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_listDocuments", async () => {
        return mcpStructured({
          documents: Array.from(openDocs.values()).map((d) => ({
            ...toDocListEntry(d),
            isActive: d.id === getActiveDocId(),
          })),
          activeDocumentId: getActiveDocId(),
          count: docCount(),
        });
      }),
    ),
  );

  server.tool(
    "tandem_switchDocument",
    "Switch the active document. Tools will operate on this document by default.",
    {
      documentId: z.string().describe("Document ID to switch to"),
    },
    withErrorBoundary("tandem_switchDocument", async ({ documentId }) => {
      if (!hasDoc(documentId)) {
        return mcpError("NO_DOCUMENT", `Document ${documentId} is not open.`);
      }
      activateDocument(documentId);
      return mcpSuccess({
        activeDocumentId: documentId,
        ...toDocListEntry(openDocs.get(documentId)!),
      });
    }),
  );

  server.tool(
    "tandem_convertToMarkdown",
    "Convert a .docx document to an editable Markdown file. Writes the .md file to disk and opens it as a new tab.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Document ID of the .docx to convert (defaults to active document)"),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Custom output DIRECTORY for the .md file (must already exist; defaults to the .docx's own directory). The filename is always derived from the source document and cannot be chosen.",
        ),
    },
    withErrorBoundary("tandem_convertToMarkdown", async ({ documentId, outputPath }) => {
      // path.basename eliminates directory components so CodeQL does not trace
      // user input through Map.get(id) to existing.filePath (js/path-injection).
      const safeDocId = documentId !== undefined ? path.basename(documentId) : undefined;
      try {
        const result = await convertToMarkdown(safeDocId, outputPath);
        return mcpSuccess({
          converted: true,
          outputPath: result.outputPath,
          documentId: result.documentId,
          fileName: result.fileName,
          message: `Converted to Markdown: ${result.fileName}`,
        });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "NO_DOCUMENT") {
          // `safeDocId` is what `convertToMarkdown` actually received. A
          // named-but-closed id gets a message echoing the (possibly
          // basename-rewritten) id itself, like `tandem_switchDocument` above —
          // `convertToMarkdown`'s own thrown message is the generic "No
          // document is open, or..." sentence, which never names the id that
          // was actually looked up.
          //
          // TRUTHINESS, not `!== undefined`: `getCurrentDoc` (registry.ts)
          // resolves `"" ?? activeDocId` to `""`, then returns null from its
          // `if (!id)` guard WITHOUT consulting the open-document map — so an
          // empty id genuinely took the no-document-at-all path and belongs on
          // the shared text. Treating it as "named" printed
          // `"Document  is not open."`: a sentence with a hole and a double
          // space, naming an id the server never looked up.
          return safeDocId
            ? mcpError("NO_DOCUMENT", `Document ${safeDocId} is not open.`)
            : noDocumentError();
        }
        if (e.code === "FILE_NOT_FOUND") return mcpError("FILE_NOT_FOUND", e.message);
        if (e.code === "INVALID_PATH") return mcpError("INVALID_PATH", e.message);
        if (e.code === "PERMISSION_DENIED") return mcpError("PERMISSION_DENIED", e.message);
        if (e.code === "EMPTY_CONVERSION") return mcpError("EMPTY_CONVERSION", e.message);
        if (e.code === "CONFLICT") return mcpError("CONFLICT", e.message);
        if (e.code === "OPEN_FAILED") return mcpError("OPEN_FAILED", e.message);
        if (e.code === "UNSUPPORTED_FORMAT") return mcpError("FORMAT_ERROR", e.message);
        throw err; // Let withErrorBoundary handle unexpected errors
      }
    }),
  );
}
