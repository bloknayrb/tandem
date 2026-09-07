import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { shouldSkipChannel, withModeRelease } from "../../shared/origins.js";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation } from "../../shared/types.js";
import { readModeState } from "../mode.js";
import { nextRev } from "./schema.js";

/**
 * WS-A2 #1769: stamp the persisted `heldInSolo` marker SERVER-SIDE.
 *
 * The marker used to be written by whichever window created the annotation,
 * from that window's own `tandemMode` rune (`Toolbar.svelte`,
 * `panels/annotation-actions.ts`). Two windows can hold different local modes —
 * the Tauri WebView and a browser tab have separate localStorage — so a comment
 * created from a window that believes it is in Tandem, into a room that reads
 * Solo, is hidden live (`hideFromAI` reads the ROOM) but carries no marker. After
 * a restart that loses the ctrl session the room reads `indeterminate`, where
 * `hideFromAI` withholds only MARKED records — so that comment is delivered.
 * Replies are already stamped server-side from `readModeState()`
 * (`lifecycle.ts`); this closes the same hole for annotations.
 *
 * ## Origin
 *
 * The stamp writes under `withModeRelease`. `MODE_RELEASE_ORIGIN` already has
 * exactly the profile this needs — in `CHANNEL_SKIP` and NOT in `DURABLE_SKIP`,
 * so the marker reaches disk (the restart case is the whole point) while never
 * becoming a channel event — and the release route's CLEAR of the same marker
 * already writes under it, so stamp and clear share one identity. NOT
 * `withBrowser`: that origin means "a user edit that originated in the browser"
 * and the skip-sets govern SERVER-side writes, so a server-origin `browser`
 * write is channel-eligible by construction.
 *
 * Being channel-skipped is also what makes the observer's own re-entry
 * impossible: `makePerKeyChangeObserver` returns on `shouldSkipChannel(origin)`
 * and so does this observer, so the nested write fires neither. Loop-freedom
 * rests on the ORIGIN, not on the `heldInSolo !== true` candidate filter (which
 * stays, as the filter). As a second property the stamp touches neither
 * `editedAt` nor `type`, so even an unskipped origin would derive no
 * `annotation:edited` from it.
 *
 * ## What it stamps
 *
 * User-authored comments whose sanitized type is `comment` and that do not
 * already carry the marker, on `add` OR `update`. The `update` arm also stamps a
 * Tandem-created comment the user edits while in Solo — the fail-closed
 * direction. The sanitized type is what is tested, never the raw one: a stored
 * legacy `question` is a comment only after sanitize, and reaches `checkInbox`
 * as one.
 *
 * The mode test is `!== "tandem"`, matching the reply stamp — so a comment
 * created while the mode key is ABSENT is stamped. The cost: such a comment
 * keeps its `Held` pill and is withheld under every later `indeterminate` until
 * a Solo→Tandem toggle clears it (only `POST /api/mode/release` clears).
 *
 * A `null` transaction origin is skipped too. A browser write reaches the server
 * with the Hocuspocus `Connection` object as origin, so null here is a restore
 * or a doc swap — skipping it is what keeps a restore from re-marking every
 * historical record.
 */
export function makeHeldInSoloStampObserver({
  docName,
  doc,
}: {
  docName: string;
  doc: Y.Doc;
}): () => void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);

  const onChange = (event: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    if (txn.origin == null) return;
    if (shouldSkipChannel(txn.origin)) return;

    const hits: Array<[string, Record<string, unknown>]> = [];
    for (const [key, change] of event.changes.keys) {
      if (change.action !== "add" && change.action !== "update") continue;
      const raw = map.get(key) as Record<string, unknown> | undefined;
      if (!raw) continue;
      if (raw.heldInSolo === true) continue;
      let ann: Annotation;
      try {
        ann = sanitizeAnnotation(raw as unknown as Annotation | RawAnnotation, () => {});
      } catch (err) {
        // NAME only — the error object can embed the annotation's own content.
        console.warn(
          `[held-in-solo] skipped unsanitizable annotation in ${docName}:`,
          err instanceof Error ? err.name : typeof err,
        );
        continue;
      }
      if (ann.author !== "user" || ann.type !== "comment") continue;
      hits.push([key, raw]);
    }

    // Return BEFORE the mode read: `readModeState()` does a lookup-or-create on
    // CTRL_ROOM, and the overwhelming majority of transactions have no candidate.
    if (hits.length === 0) return;
    if (readModeState() === "tandem") return;

    withModeRelease(doc, () => {
      for (const [key, rec] of hits) {
        // The RAW record is spread — the stamp is not a migration.
        map.set(key, { ...rec, heldInSolo: true, rev: nextRev(rec as { rev?: number }) });
      }
    });
  };

  map.observe(onChange);
  return () => map.unobserve(onChange);
}
