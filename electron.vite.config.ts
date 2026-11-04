import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs" } } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [vue()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
    server: { host: "127.0.0.1" },
  },
});
