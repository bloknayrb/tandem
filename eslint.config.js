import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },

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
