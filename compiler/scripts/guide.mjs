// prepack: the guide ships in the package (guide/diagnostics.md is the page each diagnostic code points to, and
// language.md, async.md and reference.md are what it points on to), copied from the repository's guide/.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, "../../guide");
const to = path.join(here, "../guide");
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from).filter(f => f.endsWith(".md"))) copyFileSync(path.join(from, f), path.join(to, f));
