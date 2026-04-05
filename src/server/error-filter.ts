/**
 * Discriminator for known Hocuspocus/ws errors that are safe to swallow.
 *
 * The Tandem server holds Y.Doc state in memory — crashing loses unsaved edits.
 * Hocuspocus and the `ws` library throw on malformed WebSocket frames from stale
 * browser reconnects, and Hocuspocus has internal `.catch(e => { throw e })`
 * patterns that produce unhandled rejections. These are safe to swallow.
 *
 * Everything else should crash the process so bugs are visible.
 *
 * Matched patterns:
 * - ws frame errors: RangeError/Error with WS_ERR_* code
 * - ws send-after-close: "WebSocket is not open: readyState …"
 * - lib0 decoder: "Unexpected end of array", "Integer out of Range" (defensive)
 * - Hocuspocus MessageReceiver: "Received a message with an unknown type: …" (defensive)
 */
export function isKnownHocuspocusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  if ("code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.startsWith("WS_ERR_")) {
      return true;
    }
  }

  const msg = err.message;

  if (msg.startsWith("WebSocket is not open")) return true;
  if (msg.includes("Unexpected end of array") || msg.includes("Integer out of Range")) return true;
  if (msg.startsWith("Received a message with an unknown type:")) return true;

  return false;
}
