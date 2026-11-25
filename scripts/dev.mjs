#!/usr/bin/env node
/*
 * MessagePurger — dev helper: copies the plugin into a Vencord checkout and builds it.
 * Copyright (C) 2026 HajiLight
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 *   node scripts/dev.mjs            copy the sources into Vencord
 *   node scripts/dev.mjs --build    copy, run Vencord's build, verify dist/
 *
 * Checkout lookup order: $VENCORD_DIR, ./.vencord, ../Vencord, ../vencord/Vencord.
 * A checkout is recognised by `package.json` and `src/Vencord.ts` — NOT by src/userplugins:
 * Vencord gitignores that directory and does not ship it, so a fresh clone never has one. It is
 * created here before the copy.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = "messagePurger";
const shouldBuild = process.argv.includes("--build");

function fail(message) {
    console.error(`\n  ✗ ${message}\n`);
    process.exit(1);
}

const sources = readdirSync(repo).filter(file =>
    (file.endsWith(".ts") || file.endsWith(".tsx"))
    && !file.endsWith(".test.ts")
    && !file.startsWith("vitest.config")
);

if (!existsSync(join(repo, "index.ts")) && !existsSync(join(repo, "index.tsx"))) {
    console.log("  · no plugin entrypoint (index.tsx) found — nothing to copy");
    process.exit(0);
}

function findVencord() {
    const candidates = [
        process.env.VENCORD_DIR,
        join(repo, ".vencord"),
        join(repo, "..", "Vencord"),
        join(repo, "..", "vencord", "Vencord")
    ].filter(Boolean);

    for (const candidate of candidates) {
        const dir = resolve(candidate);
        // A real checkout has src/ and package.json. src/userplugins is gitignored by Vencord and
        // absent from a fresh clone, so it cannot be the marker.
        if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "Vencord.ts"))) return dir;
    }

    fail(`No Vencord checkout found. Tried:\n${candidates.map(c => `      ${c}`).join("\n")}\n    Set VENCORD_DIR or clone Vencord to ./.vencord`);
}

const vencord = findVencord();
const userplugins = join(vencord, "src", "userplugins");
const target = join(userplugins, PLUGIN);

// Vencord does not ship this directory; create it before writing into it.
mkdirSync(userplugins, { recursive: true });

// Wipe the target first: a stale file left behind from an older version is worse than none.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const file of sources) copyFileSync(join(repo, file), join(target, file));

console.log(`  → ${target} (${sources.join(", ")})`);

if (!shouldBuild) {
    console.log("\n  Restart Discord to load it, or run `pnpm build` for a full rebuild.\n");
    process.exit(0);
}

console.log(`\n  → pnpm build in ${vencord}\n`);
const build = spawnSync("pnpm", ["build"], {
    cwd: vencord,
    stdio: "inherit",
    shell: process.platform === "win32"
});

if (build.status !== 0) fail("Vencord build failed");

const renderer = join(vencord, "dist", "renderer.js");
const sourcemap = join(vencord, "dist", "renderer.js.map");

if (!existsSync(renderer)) fail(`Build produced no ${renderer}`);

const bundle = readFileSync(renderer, "utf8");
const map = existsSync(sourcemap) ? readFileSync(sourcemap, "utf8") : "";

if (!bundle.includes("MessagePurger")) fail("The plugin is not in dist/renderer.js — check the build log above");
if (map && !map.includes(`userplugins/${PLUGIN}/index.ts`)) fail(`dist/renderer.js.map does not reference userplugins/${PLUGIN}/index.tsx`);

console.log(`\n  ✓ ${PLUGIN} is in dist/renderer.js (${(bundle.length / 1024).toFixed(0)} kB)`);
console.log("  Quit Discord completely (tray included) and start it again.\n");
