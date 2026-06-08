import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // tests/tauri-driver is a standalone sub-package with its own WebdriverIO
  // toolchain (and its own node_modules / tsconfig). Its globals (browser, $,
  // describe, expect, ...) aren't in the root resolution graph, so lint it from
  // within that package, not from the root `eslint .` sweep.
  { ignores: ["dist/**", "node_modules/**", "tests/tauri-driver/**"] },

  ...tseslint.configs.recommended,

  // React hooks rules for client code only
  {
    files: ["src/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
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
