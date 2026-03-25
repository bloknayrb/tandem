import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: true,
});
