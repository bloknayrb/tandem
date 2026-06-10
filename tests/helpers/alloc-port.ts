import { createServer } from "node:net";

/**
 * OS-assigned ephemeral port, released before resolving. Avoids hardcoded
 * ports colliding with Windows' reserved 49152–49251 range (see
 * `reference_windows_reserved_port_range`). The port is free at resolution
 * time but unreserved — bind it promptly.
 */
export function allocPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("unexpected address"));
        return;
      }
      const p = addr.port;
      probe.close(() => resolve(p));
    });
  });
}
