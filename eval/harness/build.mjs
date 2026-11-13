// Builds one app (a run directory or a reference) into `<dir>/.build/dist` with Vite, for the tests to drive.
//   rx arm:    `rxc compile src/main.rx` → JavaScript over Solid rc.19, mounted with the .rx runtime (ref/compile/rt-web.ts)
//   react and xstate arms: `src/App.tsx` (default export) mounted with createRoot under StrictMode, as Vite's React template does
//   solid arm: `src/App.tsx` (default export) compiled by @solidjs/compiler (Solid 2's JSX compiler) and mounted with
//              @solidjs/web's `render`
//   vanilla arm: `src/main.ts` default-exports `mount(root: HTMLElement)`, called once with the `#app` container
//   foldkit arm: `src/main.ts` exports Model, init, update and view; booted with Runtime.makeApplication and
//              Runtime.run, as Foldkit's own `src/entry.ts` does
//   contract arm: an Exact app, built by its own `exact.mjs web-build` (harness/contract.mjs)
// The app's API is `src/api.js` over `src/flights.js`: every call is a flight the test lands or fails.
// Usage: node harness/build.mjs <dir> [rx|react]   (the arm defaults to what `<dir>/arm` says)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildContract } from "./contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalDir = path.resolve(here, "..");
export const RXC = process.env.RXC ?? path.resolve(evalDir, "../compiler/target/release/rxc");
export const RT_WEB = process.env.RT_WEB ?? path.resolve(evalDir, "../ref/compile/rt-web.ts");

export const armOf = dir => readFileSync(path.join(dir, "arm"), "utf8").trim();

// Solid's JSX compiler runs before Vite's esbuild pass, which then strips the types it leaves in
async function solidPlugin() {
  const { transform } = (await import("node:module")).createRequire(import.meta.url)(path.join(evalDir, "node_modules/@solidjs/compiler"));
  return {
    name: "solid-jsx", enforce: "pre",
    transform(code, id) {
      if (!/\.[jt]sx$/.test(id) || id.includes("node_modules")) return null;
      const r = transform(code, { filename: id, generate: "dom", sourceMap: true });
      return { code: r.code, map: r.map };
    },
  };
}

export async function build(dir, arm = armOf(dir)) {
  dir = realpathSync(path.resolve(dir));
  if (arm === "contract") return buildContract(dir);
  const work = path.join(dir, ".build");
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  // the app's bare imports resolve from the harness's packages
  const nm = path.join(dir, "node_modules");
  if (!existsSync(nm)) symlinkSync(path.join(evalDir, "node_modules"), nm);
  let entry;
  if (arm === "rx") {
    try { execFileSync(RXC, ["compile", path.join(dir, "src/main.rx"), "--out", path.join(work, "rx")], { stdio: "pipe" }); }
    catch (e) { return { ok: false, stage: "compile", output: String(e.stdout) + String(e.stderr) }; }
    entry = `import { createApp } from ${JSON.stringify(RT_WEB)};\nimport main from "./rx/main.mjs";\nimport * as api from ${JSON.stringify(path.join(dir, "src/api.js"))};\nconst app = createApp({ root: document.getElementById("app"), api });\napp.mount(main(app));\n`;
  } else if (arm === "solid") {
    entry = `import { render } from "@solidjs/web";\nimport { createComponent } from "solid-js";\nimport App from ${JSON.stringify(path.join(dir, "src/App.tsx"))};\nrender(() => createComponent(App, {}), document.getElementById("app"));\n`;
  } else if (arm === "foldkit") {
    entry = `import { Runtime } from "foldkit";\nimport { Model, init, update, view } from ${JSON.stringify(path.join(dir, "src/main.ts"))};\nRuntime.run(Runtime.makeApplication({ Model, init, update, view, container: document.getElementById("app") }));\n`;
  } else if (arm === "vanilla") {
    entry = `import mount from ${JSON.stringify(path.join(dir, "src/main.ts"))};\nmount(document.getElementById("app"));\n`;
  } else {
    entry = `import { StrictMode, createElement } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from ${JSON.stringify(path.join(dir, "src/App.tsx"))};\ncreateRoot(document.getElementById("app")).render(createElement(StrictMode, null, createElement(App)));\n`;
  }
  writeFileSync(path.join(work, "entry.js"), entry);
  writeFileSync(path.join(work, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>app</title></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>\n`);
  const vite = await import(pathToFileURL(path.join(evalDir, "node_modules/vite/dist/node/index.js")).href);
  const plugins = arm === "react" || arm === "xstate" ? [(await import(pathToFileURL(path.join(evalDir, "node_modules/@vitejs/plugin-react/dist/index.js")).href)).default()]
    : arm === "solid" ? [await solidPlugin()] : [];
  try {
    await vite.build({
      root: work, configFile: false, logLevel: "silent", base: "./", plugins, cacheDir: path.join(work, ".vite"),
      resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals", "react", "react-dom", "effect", "foldkit"], ...(process.env.DEV_BUILD ? { conditions: ["development", "browser", "module", "import", "default"] } : {}) },
      ...(process.env.DEV_BUILD ? { mode: "development", define: { "process.env.NODE_ENV": '"development"' } } : {}),
      build: { outDir: "dist", emptyOutDir: true, minify: false },
    });
  } catch (e) { return { ok: false, stage: "bundle", output: String(e.message ?? e) }; }
  return { ok: true, dist: path.join(work, "dist") };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  const r = await build(dir);
  if (!r.ok) { console.log(`build failed (${r.stage}):\n${r.output}`); process.exit(1); }
  console.log(`built ${path.relative(process.cwd(), r.dist)}`);
}
