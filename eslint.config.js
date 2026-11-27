import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      // Git worktrees checked out inside the repo, plus Rust build output. All
      // three are gitignored, so CI's fresh checkout never sees them -- but
      // locally they made `npm run lint` report 86k problems against CI's 230,
      // which is the difference between a usable pre-push gate and noise.
      // Flat-config ignores are relative to this file, so `node_modules/**`
      // above only covers the root copy, not a worktree's own.
      ".claude/worktrees/**",
      ".worktrees/**",
      "src-tauri/target/**",
    ],
  },

  ...tseslint.configs.recommended,

  // `.cjs` is CommonJS by extension, so `require()` is the only import form
  // available there — the ESM-oriented rule cannot be satisfied, only disabled.
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },

  // Confirm dialogs go through `confirmDialog` (src/client/utils/confirm.ts).
  // The desktop app's dialog plugin replaces `window.confirm` with an async
  // function, so `if (!confirm(msg)) return;` sees a truthy Promise and runs
  // the guarded action before the user answers. `.svelte` files are outside
  // eslint here; tests/client/no-raw-confirm.test.ts covers them.
  {
    files: ["src/client/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "confirm", message: "Use confirmDialog from src/client/utils/confirm.ts." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "confirm",
          message: "Use confirmDialog from src/client/utils/confirm.ts.",
        },
        {
          object: "globalThis",
          property: "confirm",
          message: "Use confirmDialog from src/client/utils/confirm.ts.",
        },
      ],
    },
  },

  // Cyclomatic complexity is NOT an ESLint rule here, deliberately: it is a
  // per-function ratchet in scripts/ci/complexity-ratchet.mjs (CI `check`),
  // which owns its own rule config so nothing in this file can loosen it.

  // Project-wide rule overrides
  {
    rules: {
      // Y.js attributes require `as any` casts — warn, don't block
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow _-prefixed unused params (common convention)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
