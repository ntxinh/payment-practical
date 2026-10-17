import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // `server-only` throws outside an RSC bundler; stub it out in tests.
    alias: { "server-only": new URL("./tests/server-only.stub.ts", import.meta.url).pathname },
  },
  test: {
    passWithNoTests: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    env: { DATABASE_URL: "file:./tests/.tmp/test.db" },
  },
});
