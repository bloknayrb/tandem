import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  isBinaryFormat,
  readFileForUpload,
} from "../../src/client/utils/fileUpload.js";

describe("isBinaryFormat", () => {
  it("returns true for .docx", () => {
    expect(isBinaryFormat("report.docx")).toBe(true);
  });

  it("returns true for .DOCX (case-insensitive)", () => {
    expect(isBinaryFormat("REPORT.DOCX")).toBe(true);
  });

  it("returns false for .md", () => {
    expect(isBinaryFormat("notes.md")).toBe(false);
  });

  it("returns false for .txt", () => {
    expect(isBinaryFormat("readme.txt")).toBe(false);
  });

  it("returns false for .html", () => {
    expect(isBinaryFormat("page.html")).toBe(false);
  });

  it("handles filenames with multiple dots", () => {
    expect(isBinaryFormat("my.report.final.docx")).toBe(true);
    expect(isBinaryFormat("my.report.final.md")).toBe(false);
  });
});

describe("arrayBufferToBase64", () => {
  it("encodes empty buffer", () => {
    const buf = new ArrayBuffer(0);
    expect(arrayBufferToBase64(buf)).toBe("");
  });

  it("encodes simple ASCII string", () => {
    const encoder = new TextEncoder();
    const buf = encoder.encode("Hello").buffer;
    const b64 = arrayBufferToBase64(buf);
    expect(b64).toBe(btoa("Hello"));
  });

  it("encodes binary data", () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    // Verify round-trip
    const decoded = atob(b64);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(1)).toBe(1);
    expect(decoded.charCodeAt(2)).toBe(255);
    expect(decoded.charCodeAt(3)).toBe(128);
    expect(decoded.charCodeAt(4)).toBe(64);
  });

  it("produces valid base64 string", () => {
    const bytes = new Uint8Array(100);
    for (let i = 0; i < 100; i++) bytes[i] = i;
    const b64 = arrayBufferToBase64(bytes.buffer);
    expect(b64).toMatch(/^[A-Za-z0-9+/=]*$/);
  });
});

describe("readFileForUpload", () => {
  it("reads text file as plain text", async () => {
    const file = new File(["Hello world"], "test.md", { type: "text/markdown" });
    const result = await readFileForUpload(file);
    expect(result).toBe("Hello world");
  });

  it("reads .docx file as base64", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]); // PK zip header
    const file = new File([bytes], "test.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const result = await readFileForUpload(file);
    // Should be base64 encoded
    expect(result).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Verify it round-trips
    const decoded = atob(result);
    expect(decoded.charCodeAt(0)).toBe(80); // 'P'
    expect(decoded.charCodeAt(1)).toBe(75); // 'K'
  });

  it("reads .txt file as plain text", async () => {
    const file = new File(["plain text content"], "notes.txt", { type: "text/plain" });
    const result = await readFileForUpload(file);
    expect(result).toBe("plain text content");
  });

  it("reads .html file as plain text", async () => {
    const file = new File(["<p>hello</p>"], "page.html", { type: "text/html" });
    const result = await readFileForUpload(file);
    expect(result).toBe("<p>hello</p>");
  });
});
