import { loadRxc, type Files } from "./rxc";

export type Target = "dom" | "ssr" | "universal";

export type Diagnostic = {
  file: string;
  line?: number;
  code: string;
  rule: string;
  message: string;
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
};

export type AppOut = {
  entry?: string;
  css?: string;
  modules?: Record<string, { code: string; map: unknown; jsx?: string }>;
  diagnostics?: Diagnostic[];
  error?: string;
};

export type Result = {
  diagnostics: Diagnostic[];
  app: AppOut;
  projection: Record<string, string | null>;
  ms: number;
};

export const ENTRY = "/main.rx";

// kept across hot updates, so an edited module does not drop the loaded compiler
let call: ReturnType<typeof loadRxc> | undefined = import.meta.hot?.data.call;

export async function init() {
  const res = await fetch(`${import.meta.env.BASE_URL}rxc.wasm`);
  if (!res.ok || res.headers.get("content-type")?.includes("text/html")) throw new Error("rxc.wasm is missing: run `pnpm wasm` to build it");
  const bytes = await res.arrayBuffer();
  call = loadRxc(bytes);
  if (import.meta.hot) import.meta.hot.data.call = call;
}

/** The editor's files keyed by absolute path, as the crate reads them. */
export const toFs = (files: Record<string, string>): Files =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => ["/" + k.replace(/^\/+/, ""), v]));

const normalize = (d: any): Diagnostic => ({ ...d, message: d.message ?? d.msg ?? "" });

export function compile(files: Record<string, string>, target: Target): Result {
  if (!call) return { diagnostics: [], app: { error: "the compiler is not loaded: reload the page" }, projection: {}, ms: 0 };
  const t0 = performance.now();
  const fs = toFs(files);
  const diagnostics: Diagnostic[] = [];
  const projection: Record<string, string | null> = {};
  for (const file of Object.keys(fs).filter((f) => f.endsWith(".rx") && !f.endsWith(".d.rx"))) {
    try {
      const a = call("analyze", { file, prelude: "./prelude" }, fs);
      diagnostics.push(...(a.diagnostics ?? []).map(normalize));
      projection[file] = a.code ?? null;
    } catch (e) {
      diagnostics.push({ file, code: "PANIC", rule: "—", message: `the compiler trapped: ${(e as Error).message}` });
    }
  }
  let app: AppOut;
  try {
    app = fs[ENTRY] === undefined ? { error: "no main.rx: the program starts at main.rx" } : call("app", { entry: ENTRY, target, jsx: true }, fs);
  } catch (e) {
    app = { error: `the compiler trapped: ${(e as Error).message}` };
  }
  if (app.diagnostics) app.diagnostics = app.diagnostics.map(normalize);
  // analyze reports per file; app's checker run can name a file analyze did not (a .d.rx, say)
  for (const d of app.diagnostics ?? [])
    if (!diagnostics.some((x) => x.file === d.file && x.code === d.code && x.line === d.line)) diagnostics.push(d);
  return { diagnostics, app, projection, ms: performance.now() - t0 };
}
