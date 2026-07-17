import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5273,
    proxy: {
      "/api": "http://localhost:4100",
      "/ws": {
        target: "ws://localhost:4100",
        ws: true,
      },
    },
  },
});
