// The VS Code side: starts the .rx language server (tooling/rx-language-server) over IPC once a .rx document is open,
// and highlights ```rx blocks in the Markdown preview (markdown.js).
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { extendMarkdownIt } = require("./markdown.js");

let client;

/** TypeScript's lib folder: the setting, else the workspace's, else VS Code's own. */
function tsdk(config) {
  const set = config.get("typescript.tsdk");
  if (set) return set;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const lib = path.join(f.uri.fsPath, "node_modules", "typescript", "lib");
    if (fs.existsSync(lib)) return lib;
  }
  return path.join(vscode.env.appRoot, "extensions", "node_modules", "typescript", "lib");
}

function start(context) {
  if (client) return;
  const config = vscode.workspace.getConfiguration("reactivescript");
  // the bundled server (node build.js), else the repository's, when the extension runs from a checkout
  const bundled = context.asAbsolutePath(path.join("dist", "server.js"));
  const module = config.get("server.path") || (fs.existsSync(bundled) ? bundled : context.asAbsolutePath(path.join("..", "rx-language-server", "bin", "server.js")));
  const env = { ...process.env, ...(config.get("rxc.path") ? { RXC: config.get("rxc.path") } : {}) };
  const run = { module, transport: TransportKind.ipc, options: { env } };
  client = new LanguageClient(
    "reactivescript",
    "ReactiveScript",
    { run, debug: { ...run, options: { ...run.options, execArgv: ["--nolazy", "--inspect=6009"] } } },
    { documentSelector: [{ language: "reactivescript" }], initializationOptions: { typescript: { tsdk: tsdk(config) } } },
  );
  client.start();
}

/** The Markdown preview activates the extension too (markdown.markdownItPlugins); the server waits for a .rx file. */
function activate(context) {
  const isRx = doc => doc.languageId === "reactivescript";
  if (vscode.workspace.textDocuments.some(isRx)) start(context);
  else {
    const watch = vscode.workspace.onDidOpenTextDocument(doc => { if (isRx(doc)) { watch.dispose(); start(context); } });
    context.subscriptions.push(watch);
  }
  return { extendMarkdownIt };
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
