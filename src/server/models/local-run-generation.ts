import { randomUUID } from "node:crypto";

/**
 * A random id for this server process, stamped on every local-model run state
 * it writes (#1123 R3.4) so that a `running` state left by a process that
 * stopped mid-run reads as ended (`shared/local-run.ts`). Deliberately NOT the
 * server generation id: that one is the Hocuspocus auth token and never goes
 * through the ctrl Y.Map, while this one lands on chat rows and in the ctrl
 * session file. It authorises nothing. The editor gets it from
 * `GET /api/models/chat-answerer` (`runGeneration`). Minted at import, with no
 * disk access.
 */
export const LOCAL_RUN_GENERATION: string = randomUUID();
