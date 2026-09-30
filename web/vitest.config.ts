import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // Tests must never reach the live database or third-party sites.
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
