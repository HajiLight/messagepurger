import { defineConfig } from "vitest/config";

export default defineConfig({
    oxc: {
        jsx: {
            runtime: "automatic"
        }
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        coverage: {
            provider: "v8",
            include: ["core.ts", "discord.ts", "index.tsx"],
            reporter: ["text", "json", "json-summary"]
        }
    }
});
