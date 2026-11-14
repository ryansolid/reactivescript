// The runtime's source is the reference's (ref/compile/rt-web.ts and rt-server.ts, spec/11 CP-4a), so the package
// runs what the scenarios run: each is transpiled to dist/ as it is (Solid stays external, a peer of the app's), with
// its declarations.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../ref/compile");
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true }); mkdirSync(dist);
for (const [from, to] of [["rt-web.ts", "web"], ["rt-server.ts", "server"], ["rt-hot.ts", "hot"]]) {
  await build({ entryPoints: [path.join(src, from)], outfile: path.join(dist, `${to}.js`), format: "esm", platform: "neutral", target: "es2022", bundle: true, packages: "external", logLevel: "warning" });
}
// declarations, unchecked: the runtime uses Solid internals its types leave out (createErrorBoundary, sharedConfig,
// runInServerComponentScope); Solid's types resolve from this package's node_modules
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const config = path.join(here, ".tsconfig.build.json");
writeFileSync(config, JSON.stringify({
  compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir: "dist/types", rootDir: src, module: "nodenext", moduleResolution: "nodenext", target: "es2022", skipLibCheck: true, allowImportingTsExtensions: true, noCheck: true, paths: { "*": ["./node_modules/*"] } },
  files: [path.join(src, "rt-web.ts"), path.join(src, "rt-server.ts"), path.join(src, "rt-hot.ts")],
}));
try { execFileSync(process.execPath, [tsc, "-p", config], { stdio: "inherit", cwd: here }); }
finally { rmSync(config); }
for (const [from, to] of [["rt-web", "web"], ["rt-server", "server"], ["rt-hot", "hot"]]) writeFileSync(path.join(dist, `${to}.d.ts`), `export * from "./types/${from}.js";\n`);
