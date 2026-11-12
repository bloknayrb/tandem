import { describe, expect, it } from "vitest";

import {
  createOwnWindowPolicy,
  ownWindowOrigins,
  resolveModelsDevOrigin,
  webViewOnlyPolicy,
} from "../../../src/server/models/own-window.js";
import { TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../../src/shared/constants.js";
import { MODELS_DEV_ORIGIN_ENV } from "../../../src/shared/models/contract.js";

/**
 * The own-window origin test (#2404, R1.1, R1.2, R1.5): pure, no server.
 *
 * The two local-model settings POSTs accept a request only when the browser-set
 * `Origin` is EXACTLY one of Tandem's own page origins. These cases pin the
 * exactness: nothing here may pass by pattern, prefix or port wildcard.
 */

const TAURI_FORMS = [`http://${TAURI_HOSTNAME}`, `https://${TAURI_HOSTNAME}`, TAURI_LINUX_ORIGIN];
const BOUND = { address: "127.0.0.1", port: 3479 };

const req = (origin: unknown) =>
  ({ headers: origin === undefined ? {} : { origin } }) as unknown as Parameters<
    ReturnType<typeof createOwnWindowPolicy>["classify"]
  >[0];

describe("ownWindowOrigins", () => {
  it("is the three WebView forms and nothing else before the server is listening", () => {
    expect(ownWindowOrigins(null)).toEqual(TAURI_FORMS);
  });

  it("adds the served page's origin for a 127.0.0.1 listener", () => {
    expect(ownWindowOrigins(BOUND)).toEqual([...TAURI_FORMS, "http://127.0.0.1:3479"]);
  });

  it("serialises port 80 the way a browser does: with no port", () => {
    expect(ownWindowOrigins({ address: "127.0.0.1", port: 80 })).toEqual([
      ...TAURI_FORMS,
      "http://127.0.0.1",
    ]);
  });

  it.each(["::1", "0.0.0.0", "::", "localhost", "192.168.1.5"])(
    "a listener bound to %s gets no http origin",
    (address) => {
      expect(ownWindowOrigins({ address, port: 3479 })).toEqual(TAURI_FORMS);
    },
  );

  it.each([0, -1, 65536, 3479.5, Number.NaN])(
    "an impossible port (%s) gets no http origin",
    (port) => {
      expect(ownWindowOrigins({ address: "127.0.0.1", port })).toEqual(TAURI_FORMS);
    },
  );
});

describe("createOwnWindowPolicy.classify", () => {
  const policy = createOwnWindowPolicy({ getBound: () => BOUND });

  it.each(TAURI_FORMS)("accepts the WebView origin %s as own-window", (origin) => {
    expect(policy.classify(req(origin))).toBe("own-window");
    // …with no bound address either: the desktop window never depends on it.
    expect(webViewOnlyPolicy().classify(req(origin))).toBe("own-window");
  });

  it("accepts the served page's own origin as own-window", () => {
    expect(policy.classify(req("http://127.0.0.1:3479"))).toBe("own-window");
  });

  it("reads the bound address when the request arrives, not when the policy was built", () => {
    let bound: { address: string; port: number } | null = null;
    const late = createOwnWindowPolicy({ getBound: () => bound });
    expect(late.classify(req("http://127.0.0.1:4111"))).toBeNull();
    bound = { address: "127.0.0.1", port: 4111 };
    expect(late.classify(req("http://127.0.0.1:4111"))).toBe("own-window");
  });

  it("the served page's origin is not accepted on a ::1 bind", () => {
    const v6 = createOwnWindowPolicy({ getBound: () => ({ address: "::1", port: 3479 }) });
    expect(v6.classify(req("http://127.0.0.1:3479"))).toBeNull();
    expect(v6.classify(req("http://[::1]:3479"))).toBeNull();
    expect(v6.classify(req(`http://${TAURI_HOSTNAME}`))).toBe("own-window");
  });

  it("never accepts http://127.0.0.1:0 — not listening, or a reported port of 0", () => {
    expect(webViewOnlyPolicy().classify(req("http://127.0.0.1:0"))).toBeNull();
    const zero = createOwnWindowPolicy({ getBound: () => ({ address: "127.0.0.1", port: 0 }) });
    expect(zero.classify(req("http://127.0.0.1:0"))).toBeNull();
    expect(zero.classify(req("http://127.0.0.1"))).toBeNull();
  });

  it.each([
    ["another loopback port", "http://127.0.0.1:8080"],
    ["a port that only starts with the bound one", "http://127.0.0.1:34790"],
    ["localhost on the bound port", "http://localhost:3479"],
    ["tauri.localhost with a port", `http://${TAURI_HOSTNAME}:8080`],
    ["tauri.localhost on the bound port", `http://${TAURI_HOSTNAME}:3479`],
    ["https on the bound port", "https://127.0.0.1:3479"],
    ["the bound origin with a trailing slash", "http://127.0.0.1:3479/"],
    ["the bound origin with a path", "http://127.0.0.1:3479/x"],
    ["the bound origin with no port", "http://127.0.0.1"],
    ["an upper-cased scheme", "HTTP://127.0.0.1:3479"],
    ["a look-alike host", "http://127.0.0.1.evil.example:3479"],
    ["the opaque origin", "null"],
    ["an empty string", ""],
    ["a missing header", undefined],
    ["a repeated header, as Node joins it", "http://127.0.0.1:3479, http://127.0.0.1:3479"],
    ["a repeated header as an array", ["http://127.0.0.1:3479", "http://127.0.0.1:3479"]],
    ["the tauri scheme with another host", "tauri://localhost.evil"],
    ["the tauri scheme with a port", "tauri://localhost:80"],
    ["a non-string", 3479],
  ])("refuses %s", (_label, origin) => {
    expect(policy.classify(req(origin))).toBeNull();
  });

  it("a request with no headers object at all is refused, not thrown on", () => {
    expect(policy.classify({} as never)).toBeNull();
  });

  describe("the development allowance", () => {
    const withAllowance = createOwnWindowPolicy({
      getBound: () => BOUND,
      allowance: "http://127.0.0.1:5173",
    });

    it("admits exactly the one origin it names, as 'allowance'", () => {
      expect(withAllowance.classify(req("http://127.0.0.1:5173"))).toBe("allowance");
    });

    it.each([
      "http://127.0.0.1:5174",
      "http://127.0.0.1:51730",
      "http://127.0.0.1:517",
      "http://127.0.0.1:5173/",
      "http://localhost:5173",
      "https://127.0.0.1:5173",
      "null",
    ])("admits nothing else: %s", (origin) => {
      expect(withAllowance.classify(req(origin))).toBeNull();
    });

    it("leaves Tandem's own origins own-window", () => {
      expect(withAllowance.classify(req("http://127.0.0.1:3479"))).toBe("own-window");
      expect(withAllowance.classify(req(TAURI_LINUX_ORIGIN))).toBe("own-window");
    });

    it("own-window wins when the allowance names Tandem's own origin", () => {
      const same = createOwnWindowPolicy({
        getBound: () => BOUND,
        allowance: "http://127.0.0.1:3479",
      });
      expect(same.classify(req("http://127.0.0.1:3479"))).toBe("own-window");
    });

    it("a null or omitted allowance admits nothing extra", () => {
      for (const p of [
        createOwnWindowPolicy({ getBound: () => BOUND, allowance: null }),
        createOwnWindowPolicy({ getBound: () => BOUND }),
      ]) {
        expect(p.classify(req("http://127.0.0.1:5173"))).toBeNull();
      }
    });
  });
});

describe(`resolveModelsDevOrigin (${MODELS_DEV_ORIGIN_ENV})`, () => {
  it("unset: not active, and nothing to log", () => {
    expect(resolveModelsDevOrigin(undefined)).toEqual({ origin: null, log: null });
  });

  it.each([
    "http://127.0.0.1:5173",
    "http://127.0.0.1:4573",
    "http://127.0.0.1:1",
    "http://127.0.0.1:65535",
  ])("%s is accepted, and the one boot line names it", (value) => {
    const r = resolveModelsDevOrigin(value);
    expect(r.origin).toBe(value);
    expect(r.log).toContain(MODELS_DEV_ORIGIN_ENV);
    expect(r.log).toContain(value);
    expect(r.log).toMatch(/development and tests only/i);
    expect(r.log).not.toMatch(/NOT active/);
    expect(r.log?.split("\n")).toHaveLength(1);
  });

  it.each(TAURI_FORMS)(
    "the WebView form %s is accepted and logged as having no effect",
    (value) => {
      const r = resolveModelsDevOrigin(value);
      expect(r.origin).toBe(value);
      expect(r.log).toMatch(/already accepted/);
      expect(r.log).toMatch(/no effect/);
    },
  );

  it.each([
    ["a wildcard", "*"],
    ["the opaque origin", "null"],
    ["an empty string", ""],
    ["a space", " "],
    ["a comma list", "http://127.0.0.1:5173,http://127.0.0.1:5174"],
    ["a space list", "http://127.0.0.1:5173 http://127.0.0.1:5174"],
    ["a port range", "http://127.0.0.1:5000-6000"],
    ["a port wildcard", "http://127.0.0.1:*"],
    ["a prefix", "http://127.0.0.1:"],
    ["no port", "http://127.0.0.1"],
    ["port 80", "http://127.0.0.1:80"],
    ["port 0", "http://127.0.0.1:0"],
    ["port 65536", "http://127.0.0.1:65536"],
    ["a six-digit port", "http://127.0.0.1:517300"],
    ["a leading-zero port", "http://127.0.0.1:05173"],
    ["a trailing slash", "http://127.0.0.1:5173/"],
    ["a path", "http://127.0.0.1:5173/app"],
    ["a query", "http://127.0.0.1:5173?x=1"],
    ["leading whitespace", " http://127.0.0.1:5173"],
    ["a trailing newline", "http://127.0.0.1:5173\n"],
    ["localhost", "http://localhost:5173"],
    ["https on loopback", "https://127.0.0.1:5173"],
    ["a LAN host", "http://192.168.1.5:5173"],
    ["IPv6 loopback", "http://[::1]:5173"],
    ["a look-alike host", "http://127.0.0.1.evil.example:5173"],
    ["userinfo", "http://user@127.0.0.1:5173"],
    ["tauri.localhost with a port", `http://${TAURI_HOSTNAME}:5173`],
    ["an upper-cased scheme", "HTTP://127.0.0.1:5173"],
  ])("%s is refused, and the line says the allowance is NOT active", (_label, value) => {
    const r = resolveModelsDevOrigin(value);
    expect(r.origin).toBeNull();
    expect(r.log).toContain(MODELS_DEV_ORIGIN_ENV);
    expect(r.log).toMatch(/was refused/);
    expect(r.log).toMatch(/NOT active/);
  });

  it("quotes the refused value as JSON, so a newline in it cannot forge a log line", () => {
    const r = resolveModelsDevOrigin('http://x\n[Tandem] forged "line"');
    expect(r.log).toContain(JSON.stringify('http://x\n[Tandem] forged "line"'));
    expect(r.log?.split("\n")).toHaveLength(1);
  });

  it("truncates a long refused value", () => {
    const long = `http://${"a".repeat(500)}`;
    const r = resolveModelsDevOrigin(long);
    expect(r.origin).toBeNull();
    expect(r.log).not.toContain("a".repeat(100));
    expect(r.log).toContain("…");
  });
});
