/**
 * Unit tests for the process-identity probe helpers (#1077). The full OS
 * probe is platform-dependent; here we cover the pure decision pieces
 * (name classification, tasklist CSV parsing, PID validation) plus the
 * live-probe happy path against our own PID on POSIX/Linux CI.
 */
import { describe, expect, it } from "vitest";

import {
  isTandemLikeProcessName,
  parseTasklistCsv,
  probeProcessIdentity,
} from "../../../src/server/annotations/process-identity.js";

describe("isTandemLikeProcessName", () => {
  it("matches node and tandem variants (case-insensitive)", () => {
    expect(isTandemLikeProcessName("node")).toBe(true);
    expect(isTandemLikeProcessName("node.exe")).toBe(true);
    expect(isTandemLikeProcessName("Node.exe")).toBe(true);
    expect(isTandemLikeProcessName("node-sidecar-x86_64-pc-windows-msvc.exe")).toBe(true);
    expect(isTandemLikeProcessName("tandem")).toBe(true);
    expect(isTandemLikeProcessName("Tandem.exe")).toBe(true);
  });

  it("does not match clearly unrelated processes", () => {
    expect(isTandemLikeProcessName("chrome.exe")).toBe(false);
    expect(isTandemLikeProcessName("explorer.exe")).toBe(false);
    expect(isTandemLikeProcessName("svchost.exe")).toBe(false);
    expect(isTandemLikeProcessName("bash")).toBe(false);
  });
});

describe("parseTasklistCsv", () => {
  it("extracts the image name from a CSV match", () => {
    expect(parseTasklistCsv('"node.exe","1234","Console","1","45,678 K"\r\n')).toEqual({
      kind: "name",
      name: "node.exe",
    });
  });

  it("returns indeterminate for the no-match INFO line", () => {
    expect(
      parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n"),
    ).toEqual({ kind: "indeterminate" });
  });

  it("returns indeterminate for empty output", () => {
    expect(parseTasklistCsv("")).toEqual({ kind: "indeterminate" });
  });
});

describe("probeProcessIdentity", () => {
  it("returns indeterminate for invalid PIDs", async () => {
    expect(await probeProcessIdentity(0)).toEqual({ kind: "indeterminate" });
    expect(await probeProcessIdentity(-1)).toEqual({ kind: "indeterminate" });
    expect(await probeProcessIdentity(1.5)).toEqual({ kind: "indeterminate" });
  });

  it("identifies our own process as node-like on supported platforms", async () => {
    const identity = await probeProcessIdentity(process.pid);
    if (identity.kind === "name") {
      // vitest runs under node — whatever the platform reports must classify
      // as tandem-like, or the reclaim flow would wrongly steal live locks.
      expect(isTandemLikeProcessName(identity.name)).toBe(true);
    } else {
      // Indeterminate is acceptable (unsupported platform / hardened /proc) —
      // it fails safe in the reclaim decision.
      expect(identity).toEqual({ kind: "indeterminate" });
    }
  });

  it("returns indeterminate (not a throw) for a dead PID", async () => {
    expect(await probeProcessIdentity(999_999_999)).toEqual({ kind: "indeterminate" });
  });
});
