import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need the module to use a temp dir for data. Override env-paths by patching
// TANDEM_APP_DATA_DIR — platform.ts uses it, but token-store.ts uses env-paths
// directly. We mock the env-paths module instead.
let tempDir: string;

vi.mock("env-paths", () => ({
  default: () => ({ data: tempDir }),
}));

// Import after mocks are registered.
const { loadOrCreateToken, readTokenFromFile, writeTokenToFile, getTokenFilePath } = await import(
  "../../src/server/auth/token-store"
);

const BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;

describe("token-store", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-token-test-"));
    // Clear env token between tests
    delete process.env.TANDEM_AUTH_TOKEN;
    // Mock process.exit per the pattern used in retry.test.ts — must be in
    // beforeEach, not module scope, to avoid vitest's built-in interceptor.
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    delete process.env.TANDEM_AUTH_TOKEN;
    vi.restoreAllMocks();
  });

  describe("readTokenFromFile()", () => {
    it("returns null when file does not exist", async () => {
      const result = await readTokenFromFile();
      expect(result).toBeNull();
    });

    it("returns null when file is empty", async () => {
      await fs.promises.mkdir(path.dirname(getTokenFilePath()), { recursive: true });
      await fs.promises.writeFile(getTokenFilePath(), "", "utf8");
      const result = await readTokenFromFile();
      expect(result).toBeNull();
    });

    it("returns null when file contains only whitespace", async () => {
      await fs.promises.mkdir(path.dirname(getTokenFilePath()), { recursive: true });
      await fs.promises.writeFile(getTokenFilePath(), "   \n  ", "utf8");
      const result = await readTokenFromFile();
      expect(result).toBeNull();
    });
  });

  describe("writeTokenToFile() + readTokenFromFile() roundtrip", () => {
    it("persists a token and reads it back", async () => {
      const token = crypto.randomBytes(32).toString("base64url");
      await writeTokenToFile(token);
      const read = await readTokenFromFile();
      expect(read).toBe(token);
    });

    it("creates parent directories if missing", async () => {
      const originalTempDir = tempDir;
      // Re-route getTokenFilePath() to a deeply nested path that doesn't exist yet.
      // The env-paths mock uses a closure over `tempDir`, so changing it here redirects
      // writeTokenToFile/readTokenFromFile to the new path.
      tempDir = path.join(originalTempDir, "nested", "sub");
      try {
        const token = crypto.randomBytes(32).toString("base64url");
        await writeTokenToFile(token);
        expect(await readTokenFromFile()).toBe(token);
      } finally {
        // Restore so afterEach rm covers the whole subtree
        tempDir = originalTempDir;
      }
    });
  });

  describe("loadOrCreateToken()", () => {
    it("creates token file on first call", async () => {
      const token = await loadOrCreateToken();
      expect(token).not.toBeNull();
      expect(token).toMatch(BASE64URL_RE);
      // File now exists
      const fromFile = await readTokenFromFile();
      expect(fromFile).toBe(token);
    });

    it("reuses existing token on second call", async () => {
      const first = await loadOrCreateToken();
      const second = await loadOrCreateToken();
      expect(second).toBe(first);
    });

    it("regenerates token when file is empty", async () => {
      await fs.promises.mkdir(path.dirname(getTokenFilePath()), { recursive: true });
      await fs.promises.writeFile(getTokenFilePath(), "", "utf8");
      const token = await loadOrCreateToken();
      expect(token).not.toBeNull();
      expect(token).toMatch(BASE64URL_RE);
    });

    it("returns env var without touching the file when TANDEM_AUTH_TOKEN is set", async () => {
      const envToken = "env-token-for-testing-abc";
      process.env.TANDEM_AUTH_TOKEN = envToken;
      const result = await loadOrCreateToken();
      expect(result).toBe(envToken);
      // File must not be created
      const fromFile = await readTokenFromFile();
      expect(fromFile).toBeNull();
    });

    it("generated token matches base64url-of-32-bytes format", async () => {
      const token = await loadOrCreateToken();
      expect(token).toMatch(BASE64URL_RE);
    });

    it("adopts existing token when open(wx) throws EEXIST (O_EXCL race)", async () => {
      // No file on disk yet — loadOrCreateToken will generate a token and try
      // open(wx). The spy writes the "winner's" token to disk before throwing
      // EEXIST — this is the critical invariant: readTokenFromFile must find a
      // real token there so our code adopts the winner's value, not its own.
      const winnerToken = crypto.randomBytes(32).toString("base64url");
      const filePath = getTokenFilePath();
      const originalOpen = fs.promises.open;
      let exclAttempted = false;

      vi.spyOn(fs.promises, "open").mockImplementation(
        async (fp: fs.PathLike | fs.promises.FileHandle, flags: fs.OpenMode, ...rest) => {
          if (!exclAttempted && flags === "wx") {
            exclAttempted = true;
            // Simulate the racing process: persist its token, then surface EEXIST.
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, winnerToken, "utf8");
            throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
          }
          // @ts-expect-error — spread rest args for arity compat
          return originalOpen(fp, flags, ...rest);
        },
      );

      const result = await loadOrCreateToken();
      // Must adopt the winner's token, not the one we generated.
      expect(result).toBe(winnerToken);
      // Verify the EEXIST branch actually fired (not just the file-read path).
      expect(exclAttempted).toBe(true);
    });

    it("calls process.exit(1) when randomBytes throws", async () => {
      vi.spyOn(crypto, "randomBytes").mockImplementationOnce(() => {
        throw new Error("Entropy source failed");
      });

      // vitest intercepts process.exit and throws its own error — we just
      // verify it was called with the right code rather than matching message.
      await expect(loadOrCreateToken()).rejects.toThrow();
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) when writeTokenToFile throws (EPERM)", async () => {
      // Simulate unwritable directory: open("wx") throws EPERM
      vi.spyOn(fs.promises, "open").mockRejectedValue(
        Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
      );
      await expect(loadOrCreateToken()).rejects.toThrow();
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
