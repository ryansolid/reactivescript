// The .rx language plugin for Volar (spec/11 CP-8). A `.rx` file's virtual code is its TSX projection (spec/13 TY-1c),
// made by the crate with mappings onto the `.rx`: TypeScript's hover, definition, references, rename, completion and
// type errors come back through them. The crate's own diagnostics (rule IDs, spec/99) are a service of their own.
const { analyze, preludeFor } = require("./rxc");

/** The page that explains a diagnostic code and its fix (the compiler's guide/diagnostics.md, one section a code). */
const guideUrl = code => `https://github.com/solidjs/reactivescript/blob/main/guide/diagnostics.md#${String(code).toLowerCase()}`;

/** Every feature, where the projection copies the `.rx`'s text (a name, a member, a literal, a type, a tag). */
const EXACT = { verification: true, completion: true, semantic: true, navigation: true, structure: true, format: false };
/** Where it wrote text for a piece of the `.rx` (an expression, a statement): only for placing type errors. */
const COARSE = { verification: true };

/** A module: `.rx`, not a declaration file (`.d.rx`, MO-8/MO-9), which the crate reads beside the modules that import it. */
const isModule = f => f.endsWith(".rx") && !f.endsWith(".d.rx");
/** `include` globs take `.d.rx` too; Volar's tsc stops on a program file with no script, so it is an empty module. */
const isDeclaration = f => f.endsWith(".d.rx");

const snapshotOf = text => ({ getText: (s, e) => text.slice(s, e), getLength: () => text.length, getChangeRange: () => undefined });

/** The last analysis of each file, by its text: the virtual code and the diagnostics share one `rxc` run. */
const cache = new Map();
function analysis(file, text) {
  const hit = cache.get(file);
  if (hit && hit.text === text) return hit.result;
  let result;
  try { result = analyze(file, text, preludeFor(file)); } catch (e) {
    console.error(`rx: analyzing ${file} failed: ${e?.stack ?? e}`); // the server's log, else the failure is silent
    result = { code: null, mappings: [], ranges: [], diagnostics: [], error: String(e) };
  }
  cache.set(file, { text, result });
  return result;
}

function virtualCode(file, snapshot) {
  const text = snapshot.getText(0, snapshot.getLength());
  const a = analysis(file, text);
  const code = a.code ?? "";
  const mappings = [
    ...(a.mappings ?? []).map(([g, s, n]) => ({ sourceOffsets: [s], generatedOffsets: [g], lengths: [n], data: EXACT })),
    ...(a.ranges ?? []).map(([g, gn, s, n]) => ({ sourceOffsets: [s], generatedOffsets: [g], lengths: [n], generatedLengths: [gn], data: COARSE })),
  ];
  return {
    id: "root",
    languageId: "reactivescript",
    snapshot,
    mappings: [{ sourceOffsets: [0], generatedOffsets: [0], lengths: [text.length], data: { verification: true, completion: true, semantic: true, navigation: true, structure: true, format: true } }],
    embeddedCodes: [{ id: "tsx", languageId: "typescriptreact", snapshot: snapshotOf(code), mappings }],
  };
}

function declarationCode(snapshot) {
  return { id: "root", languageId: "reactivescript-declaration", snapshot, mappings: [], embeddedCodes: [{ id: "ts", languageId: "typescript", snapshot: snapshotOf("export {};\n"), mappings: [] }] };
}

/** @param {typeof import("typescript")} ts */
function rxLanguagePlugin(ts, asFileName = uri => uri.fsPath ?? String(uri)) {
  return {
    getLanguageId(id) {
      const f = String(id.path ?? id);
      return isModule(f) ? "reactivescript" : isDeclaration(f) ? "reactivescript-declaration" : undefined;
    },
    createVirtualCode(id, languageId, snapshot) {
      if (languageId === "reactivescript-declaration" || isDeclaration(asFileName(id))) return declarationCode(snapshot);
      if (languageId !== "reactivescript" || !isModule(asFileName(id))) return undefined;
      return virtualCode(asFileName(id), snapshot);
    },
    typescript: {
      extraFileExtensions: [{ extension: "rx", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }],
      getServiceScript(root) {
        const tsx = root.embeddedCodes?.find(c => c.id === "tsx");
        if (tsx) return { code: tsx, extension: ".tsx", scriptKind: ts.ScriptKind.TSX };
        const decl = root.embeddedCodes?.find(c => c.id === "ts");
        return decl ? { code: decl, extension: ".ts", scriptKind: ts.ScriptKind.TS } : undefined;
      },
    },
  };
}

/** The crate's diagnostics on a `.rx` document: the editor's parse's errors, else the checker's (CP-8d). Volar hands
 *  the service the root virtual code's document, whose URI encodes the `.rx` file's. */
function rxDiagnostics() {
  return {
    name: "reactivescript-diagnostics",
    capabilities: { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } },
    create(context) {
      return {
        provideDiagnostics(document) {
          if (document.languageId !== "reactivescript") return;
          const { URI } = require("vscode-uri");
          const uri = URI.parse(document.uri);
          const source = context.decodeEmbeddedDocumentUri(uri)?.[0] ?? uri;
          if (source.scheme !== "file") return;
          const file = source.fsPath;
          if (!isModule(file)) return;
          const a = analysis(file, document.getText());
          return (a.diagnostics ?? []).filter(d => d.range).map(d => ({
            range: {
              start: { line: d.range.start.line - 1, character: d.range.start.column },
              end: { line: d.range.end.line - 1, character: d.range.end.column },
            },
            severity: 1,
            source: "rx",
            code: d.code,
            codeDescription: { href: guideUrl(d.code) },
            message: `${d.message} (${d.rule})`,
          }));
        },
      };
    },
  };
}

/** Every `.rx` module analyzed so far, with its last analysis (the command line reports their crate diagnostics). */
const analyses = () => [...cache].filter(([f]) => isModule(f)).map(([file, { result }]) => ({ file, result }));

module.exports = { rxLanguagePlugin, rxDiagnostics, analysis, analyses, guideUrl };
