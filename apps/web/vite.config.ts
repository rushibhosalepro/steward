import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the UI calls /api/* and Vite forwards it to the Bun API (default :8787,
// override with STEWARD_API=http://localhost:<port>).
const api = process.env.STEWARD_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: api, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
