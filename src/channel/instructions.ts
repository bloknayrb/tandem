/**
 * The channel shim's MCP `instructions` string, exported so a test can measure
 * it (#2287): Claude Code 2.1.84–2.1.295 truncates server instructions and tool
 * descriptions at 2,048 characters, so this must stay well inside that.
 *
 * Imports only shared constants. The shim is a define-less bundle and must
 * never reach licence code (`tests/server/license-module-seam.test.ts`).
 */

import { LICENSE_REFUSED_EVENT_TYPE, TANDEM_EVENT_TYPES } from "../shared/events/types.js";
import { CHAT_ACK_RULE } from "../shared/launcher/contract.js";

export const CHANNEL_INSTRUCTIONS = [
  'Events from Tandem arrive as <channel source="tandem-channel" event_type="..." document_id="...">.',
  "These are real-time push notifications of user actions in the collaborative document editor.",
  `Event types: ${TANDEM_EVENT_TYPES.join(", ")},`,
  `and ${LICENSE_REFUSED_EVENT_TYPE} (a notice, sent once per refused stretch, that Tandem's licence refused this event stream).`,
  "Chat messages may include a 'selection' field with buffered selection context.",
  "Use your tandem MCP tools (tandem_getTextContent, tandem_comment, tandem_edit, etc.) to act on them.",
  "Reply to chat messages using tandem_reply. Pass document_id from the tag attributes.",
  CHAT_ACK_RULE,
  "Do not reply to non-chat events — just act on them using tools.",
  "Push is best-effort and can drop events; tandem_checkInbox is the authority on user activity, so keep polling it between steps.",
].join(" ");
