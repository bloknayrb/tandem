/**
 * #1123 (LM Studio and "another local server", 2026-11-15), the server half:
 *  - R1.3: a `models.json` written by the build before this change loads
 *    unchanged and byte-identically (no migration; `schemaVersion` stays 1),
 *    and entries of both new values survive read, write and read;
 *  - R1.2: every derived provider list holds every provider;
 *  - R2.4: every address prefill is empty or a loopback address
 *    `validateEndpoint` accepts, with path `/` and no `/v1`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateEndpoint } from "../../../src/server/local-model/config.js";
import {
  createModelStore,
  MODELS_FILE_NAME,
  serializeModelsFile,
} from "../../../src/server/models/store.js";
import {
  isLocalProvider,
  LOCAL_MODEL_PROVIDERS,
  MODELS_SCHEMA_VERSION,
  type ModelProvider,
  VALID_MODEL_PROVIDERS,
} from "../../../src/shared/models/contract.js";
import {
  endpointAfterProviderChange,
  LOCAL_ENDPOINT_PREFILL,
  MODELS_TAB_ORDER,
  nameFallback,
  PROVIDER_LABEL,
  PROVIDER_OPTION_ORDER,
} from "../../../src/shared/models/provider-ui.js";
import { AgentIdentitySchema } from "../../../src/shared/types.js";

/** Exactly the bytes the previous build writes (`serializeModelsFile`: two-space
 *  JSON in schema key order, trailing newline). Written by hand, not computed. */
const MASTER_SHAPED = `{
  "schemaVersion": 1,
  "models": [
    {
      "id": "a",
      "provider": "local-ollama",
      "displayName": "Qwen",
      "modelId": "qwen2.5:14b",
      "endpoint": "http://localhost:11434",
      "enabled": true
    },
    {
      "id": "b",
      "provider": "local-llamacpp",
      "displayName": "Llama",
      "modelId": "local-model",
      "endpoint": "http://127.0.0.1:8080",
      "enabled": false,
      "params": {
        "temperature": 0.2
      }
    },
    {
      "id": "c",
      "provider": "anthropic",
      "displayName": "Claude",
      "modelId": "claude-opus-4-8",
      "apiKeyRef": "ref-abc",
      "enabled": true
    }
  ],
  "defaultModelId": "a"
}
`;

const BOTH_NEW = `{
  "schemaVersion": 1,
  "models": [
    {
      "id": "s",
      "provider": "local-lmstudio",
      "displayName": "Studio",
      "modelId": "qwen",
      "endpoint": "http://127.0.0.1:1234/v1",
      "enabled": true
    },
    {
      "id": "o",
      "provider": "local-other",
      "displayName": "Local server",
      "modelId": "m",
      "endpoint": "http://127.0.0.1:8000",
      "enabled": true
    }
  ],
  "defaultModelId": "s"
}
`;

describe("models.json round trips (R1.3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-models-local-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  for (const [name, bytes] of [
    ["a file written before this change", MASTER_SHAPED],
    ["a file holding both new providers", BOTH_NEW],
  ] as const) {
    it(`${name}: read, serialize, write and read again, byte-identical`, async () => {
      const file = path.join(tmpDir, MODELS_FILE_NAME);
      await fs.promises.writeFile(file, bytes, "utf8");
      const store = createModelStore(tmpDir);
      const first = await store.read();
      expect(first.schemaVersion).toBe(MODELS_SCHEMA_VERSION);
      expect(serializeModelsFile(first)).toBe(bytes);
      await store.write(first);
      expect(await fs.promises.readFile(file, "utf8")).toBe(bytes);
      expect(await store.read()).toEqual(first);
      // Nothing was backed up as broken.
      expect((await fs.promises.readdir(tmpDir)).sort()).toEqual([MODELS_FILE_NAME]);
    });
  }

  it("an annotation byline of either new provider validates", () => {
    for (const provider of ["local-lmstudio", "local-other"] as const) {
      expect(AgentIdentitySchema.safeParse({ provider, displayName: "x" }).success).toBe(true);
    }
  });
});

describe("derived provider lists hold every provider (R1.2)", () => {
  it("the two orders and the label map cover VALID_MODEL_PROVIDERS exactly once", () => {
    const all = [...VALID_MODEL_PROVIDERS].sort();
    expect([...MODELS_TAB_ORDER].sort()).toEqual(all);
    expect([...PROVIDER_OPTION_ORDER].sort()).toEqual(all);
    expect(Object.keys(PROVIDER_LABEL).sort()).toEqual(all);
    expect(MODELS_TAB_ORDER[0]).toBe("anthropic");
    expect(PROVIDER_OPTION_ORDER.slice(0, LOCAL_MODEL_PROVIDERS.length)).toEqual([
      ...LOCAL_MODEL_PROVIDERS,
    ]);
  });

  it("the new values are appended and local", () => {
    expect(VALID_MODEL_PROVIDERS.slice(-2)).toEqual(["local-lmstudio", "local-other"]);
    expect(LOCAL_MODEL_PROVIDERS).toEqual([
      "local-ollama",
      "local-llamacpp",
      "local-lmstudio",
      "local-other",
    ]);
  });
});

describe("address prefills (R2.1, R2.4)", () => {
  it("cloud and Other have none", () => {
    for (const p of VALID_MODEL_PROVIDERS.filter((x) => !isLocalProvider(x))) {
      expect(LOCAL_ENDPOINT_PREFILL[p]).toBe("");
    }
    expect(LOCAL_ENDPOINT_PREFILL["local-other"]).toBe("");
  });

  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`${p}: empty, or accepted by validateEndpoint with path / and no /v1`, () => {
      const v = LOCAL_ENDPOINT_PREFILL[p];
      if (v === "") return;
      const check = validateEndpoint(v);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.url.pathname).toBe("/");
      expect(v).not.toContain("/v1");
      expect(new URL(v).hostname).toBe("127.0.0.1");
    });
  }
});

// #1123, the add-model window's fields (R1.2): the address follows a provider
// change only while it holds the previous provider's usual address, strictly.
describe("endpointAfterProviderChange (R1.2, rows A2 to A7)", () => {
  const rows: ReadonlyArray<readonly [string, string, ModelProvider, ModelProvider, string]> = [
    ["A2", "http://127.0.0.1:11434", "local-ollama", "local-lmstudio", "http://127.0.0.1:1234"],
    ["A2", "http://127.0.0.1:11434", "local-ollama", "local-llamacpp", ""],
    ["A2", "http://127.0.0.1:11434", "local-ollama", "local-other", ""],
    ["A3", "", "local-llamacpp", "local-ollama", "http://127.0.0.1:11434"],
    ["A3", "", "local-other", "local-lmstudio", "http://127.0.0.1:1234"],
    ["A4", "http://127.0.0.1:5555", "local-ollama", "local-lmstudio", "http://127.0.0.1:5555"],
    ["A4", "http://127.0.0.1:5555", "local-lmstudio", "local-llamacpp", "http://127.0.0.1:5555"],
    ["A4", "http://127.0.0.1:5555", "local-llamacpp", "local-other", "http://127.0.0.1:5555"],
    ["A5", "http://127.0.0.1:11434 ", "local-ollama", "local-lmstudio", "http://127.0.0.1:11434 "],
    ["A6", "http://127.0.0.1:11434/", "local-ollama", "local-lmstudio", "http://127.0.0.1:11434/"],
    ["A7", "", "local-ollama", "local-lmstudio", ""],
  ];
  it.each(rows)("%s: %j, %s to %s gives %j", (_row, current, from, to, after) => {
    expect(endpointAfterProviderChange(current, from, to)).toBe(after);
  });
});

describe("nameFallback (R2.1, Ruling L-h)", () => {
  it("is each local provider's label, and Other's is 'Local server'", () => {
    expect(nameFallback("local-ollama")).toBe("Ollama (local)");
    expect(nameFallback("local-llamacpp")).toBe("llama.cpp (local)");
    expect(nameFallback("local-lmstudio")).toBe("LM Studio (local)");
    expect(nameFallback("local-other")).toBe("Local server");
  });
});
