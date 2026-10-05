import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pwaPlugin } from "./pwa";

export default defineConfig({
  plugins: [react(), pwaPlugin()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:7777", changeOrigin: true } },
  },
});
