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

    it("creates parent directory if missing", async () => {
      const token = crypto.randomBytes(32).toString("base64url");
      // tempDir exists but no sub-dir for the token file yet
      const nestedDir = path.join(tempDir, "nested", "sub");
      vi.spyOn(path, "dirname").mockReturnValueOnce(nestedDir);
      // Re-implement: just verify writeTokenToFile handles recursive mkdir
      await writeTokenToFile(token);
      const read = await readTokenFromFile();
      expect(read).toBe(token);
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

    describe("O_EXCL race simulation", () => {
      it("adopts existing token when open(wx) throws EEXIST", async () => {
        // No file on disk yet — loadOrCreateToken will generate a token and try
        // open(wx). The spy intercepts, writes the "winner's" token inline
        // (simulating the racing process winning), then throws EEXIST. Our code
        // must fall back to readTokenFromFile and return the winner's token.
        const winnerToken = crypto.randomBytes(32).toString("base64url");
        const filePath = getTokenFilePath();
        const originalOpen = fs.promises.open;
        let exclAttempted = false;

        vi.spyOn(fs.promises, "open").mockImplementation(
          async (fp: fs.PathLike | fs.promises.FileHandle, flags: fs.OpenMode, ...rest) => {
            if (!exclAttempted && flags === "wx") {
              exclAttempted = true;
              // Write the winner's token to disk before throwing — simulates the
              // other process winning the O_EXCL race and persisting its token.
              await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
              await fs.promises.writeFile(filePath, winnerToken, "utf8");
              throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
            }
            // @ts-ignore — spread rest args for arity compat
            return originalOpen(fp, flags, ...rest);
          },
        );

        const result = await loadOrCreateToken();
        // Must adopt the winner's token, not the one we generated.
        expect(result).toBe(winnerToken);
        // Verify the EEXIST branch actually fired (not just the file-read path).
        expect(exclAttempted).toBe(true);
      });
    });

    describe("process.exit on crypto failure", () => {
      it("calls process.exit(1) when randomBytes throws", async () => {
        vi.spyOn(crypto, "randomBytes").mockImplementationOnce(() => {
          throw new Error("Entropy source failed");
        });

        // vitest intercepts process.exit and throws its own error — we just
        // verify it was called with the right code rather than matching message.
        await expect(loadOrCreateToken()).rejects.toThrow();
        expect(mockExit).toHaveBeenCalledWith(1);
      });
    });
  });
});
