import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@frenchfryai/core": `${projectRoot}packages/core/src/index.ts`,
      "@frenchfryai/react": `${projectRoot}packages/react/src/index.ts`,
      "@frenchfryai/runtime": `${projectRoot}packages/runtime/src/index.ts`
    }
  },
  test: {
    coverage: {
      enabled: true,
      include: [
        "packages/core/src/index.ts",
        "packages/core/src/protocol.ts",
        "packages/core/src/tool-orchestration.ts",
        "packages/react/src/index.ts",
        "packages/runtime/src/index.ts",
        "packages/runtime/src/protocol.ts",
        "demos/server/src/index.ts"
      ],
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 95,
        functions: 95,
        lines: 95,
        statements: 95
      }
    },
    environment: "node",
    globals: false,
    include: ["packages/*/test/**/*.test.ts", "demos/server/test/**/*.test.ts"],
    passWithNoTests: false
  }
});
