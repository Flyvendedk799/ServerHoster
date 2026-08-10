import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative base so the built bundle also works when it is dropped into a
  // subpath — e.g. served by the ServerHoster control plane itself at /m/,
  // which is the zero-CORS way to run this.
  base: "./",
  server: {
    port: 5174,
    // A phone on the same Wi-Fi needs to reach the dev server by LAN IP.
    host: true
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"]
  }
});
