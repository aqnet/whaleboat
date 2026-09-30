import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same "@/..." imports as the app (tsconfig paths).
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // Tests must never reach the live database or third-party sites.
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
