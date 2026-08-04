import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "transport",
        root: ".",
        include: ["tests/**/*.test.ts"],
        environment: "node",
        globals: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            reporter: ["text", "json-summary"],
        },
    },
});
