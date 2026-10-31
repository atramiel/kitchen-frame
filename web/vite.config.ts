import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8080", "/go2rtc": { target: "http://127.0.0.1:8080", ws: true } } },
});
