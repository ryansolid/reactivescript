import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  server: { port: 3020, strictPort: true },
  build: { target: "esnext" },
});
