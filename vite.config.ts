import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Dev stays at "/"; CI builds for GitHub Pages set BASE_PATH to the project
  // subpath (e.g. "/kingscanyon-backpacking/").
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
});
