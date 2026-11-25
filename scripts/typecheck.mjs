#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Type check against the Vencord checkout that is actually present.
//
// `tsconfig.json` avoids `"extends": "./.vencord/tsconfig.json"` so Vitest and `tsc` do not fail
// on a fresh clone where Vencord is not at `.vencord`. This script locates the checkout the same
// way `dev.mjs` does, generates a throwaway config extending the one it found, and runs `tsc`
// against it. With no checkout at all it says so and exits 0, because the unit tests do not need
// Vencord and a stranger should not see a red build for a repository they only want to read.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const candidates = [
    process.env.VENCORD_DIR,
    join(repo, ".vencord"),
    join(repo, "..", "Vencord"),
    join(repo, "..", "vencord", "Vencord")
].filter(dir => typeof dir === "string" && dir !== "");
const found = candidates.find(dir => existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "Vencord.ts")));

if (!found) {
    console.log("No Vencord checkout found — skipping the type check.");
    console.log("The unit tests do not need one, so `pnpm test` still works on its own.");
    console.log("For a full check, clone Vencord to ./.vencord or point VENCORD_DIR at a checkout.");
    process.exit(0);
}

function commonRoot(a, b) {
    const partsA = resolve(a).split(/[\\/]+/);
    const partsB = resolve(b).split(/[\\/]+/);
    const sameRoot = process.platform === "win32"
        ? partsA[0].toLowerCase() === partsB[0].toLowerCase()
        : partsA[0] === partsB[0];
    if (!sameRoot) return undefined;

    const shared = [];
    for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
        const same = process.platform === "win32"
            ? partsA[i].toLowerCase() === partsB[i].toLowerCase()
            : partsA[i] === partsB[i];
        if (!same) break;
        shared.push(partsA[i]);
    }
    if (shared.length === 0) return undefined;
    const joined = shared.join("/");
    return joined === "" ? "/" : joined.endsWith(":") ? `${joined}/` : joined;
}

// tsc only treats an `extends` path as a file when it starts with "./" or "../"; anything else is
// looked up as a package name and, when that fails, silently ignored.
const rel = path => {
    const local = relative(repo, join(found, path)).split("\\").join("/");
    const explicitlyRelative = local.startsWith("./") || local.startsWith("../");
    return explicitlyRelative ? local : `./${local}`;
};
const root = commonRoot(repo, found);
const rootDir = root ? (relative(repo, root).split("\\").join("/") || ".") : undefined;
const config = {
    extends: rel("tsconfig.json"),
    compilerOptions: {
        noEmit: true,
        ...(rootDir ? { rootDir } : {}),
        types: ["node", "standalone-electron-types"]
    },
    include: ["*.ts", "*.tsx", "tests/**/*.ts", rel("src/globals.d.ts"), rel("src/modules.d.ts"), rel("src/nativeModules.d.ts")]
};

const temporary = join(repo, "tsconfig.check.json");
writeFileSync(temporary, `${JSON.stringify(config, null, 4)}\n`, "utf8");

try {
    console.log(`Type check against ${found}`);
    const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", temporary], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(temporary, { force: true });
}
