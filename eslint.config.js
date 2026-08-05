import tseslint from "typescript-eslint";

export default tseslint.config(
  // tests/tauri-driver is a standalone sub-package with its own WebdriverIO
  // toolchain (and its own node_modules / tsconfig). Its globals (browser, $,
  // describe, expect, ...) aren't in the root resolution graph, so lint it from
  // within that package, not from the root `eslint .` sweep.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/tauri-driver/**",
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
