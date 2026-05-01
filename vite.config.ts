import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), svelte()],
  root: ".",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@client": path.resolve(__dirname, "src/client"),
    },
    dedupe: [
      "yjs",
      "@hocuspocus/provider",
      "y-prosemirror",
      "prosemirror-model",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-transform",
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:3478",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist/client",
  },
});
