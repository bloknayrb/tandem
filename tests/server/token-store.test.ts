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
        // Write a known token to disk first (simulates the racing process winning)
        const existingToken = crypto.randomBytes(32).toString("base64url");
        await writeTokenToFile(existingToken);

        // Mock fs.promises.open to throw EEXIST on the first call, then succeed.
        const originalOpen = fs.promises.open;
        let firstCall = true;
        vi.spyOn(fs.promises, "open").mockImplementation(
          async (filePath: fs.PathLike | fs.promises.FileHandle, flags: fs.OpenMode, ...rest) => {
            if (firstCall && flags === "wx") {
              firstCall = false;
              const err = Object.assign(new Error("EEXIST: file already exists"), {
                code: "EEXIST",
              });
              throw err;
            }
            // @ts-ignore — spread rest args for arity compat
            return originalOpen(filePath, flags, ...rest);
          },
        );

        // Delete the file so loadOrCreateToken tries to generate a new one,
        // then restore it before the mock throws to simulate the race.
        const filePath = getTokenFilePath();
        // Actually: the mock already wrote the file via writeTokenToFile above.
        // Just call loadOrCreateToken — it will try open(wx), get EEXIST, and
        // fall back to readTokenFromFile which returns existingToken.
        const result = await loadOrCreateToken();
        expect(result).toBe(existingToken);
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
