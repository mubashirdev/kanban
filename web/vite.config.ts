import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { brandPlugin } from "./addons/brand-plugin";

export default defineConfig({
  plugins: [react(), brandPlugin()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:7777", changeOrigin: true } },
  },
});
