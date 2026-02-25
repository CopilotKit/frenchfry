import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@frenchfryai/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url)
      ),
      "@frenchfryai/react": fileURLToPath(
        new URL("../../packages/react/src/index.ts", import.meta.url)
      )
    }
  }
});
