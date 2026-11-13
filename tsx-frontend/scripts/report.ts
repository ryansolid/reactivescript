// Fail closed: the exact kept tests must finish once, pass, and not be skipped.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export type Row = {
  file: string;
  name: string;
  status: string;
  error?: string;
};
export const id = (row: Row) =>
  row.file.replaceAll("\\", "/").replace(/^.*\/(tsx|yield)\//, "$1/") +
  " :: " +
  row.name;
export function checkTests(
  rows: Row[],
  expected: string[],
  summary: string,
): string[] {
  const problems: string[] = [];
  for (const key of expected) {
    const matches = rows.filter((row) => id(row) === key);
    if (matches.length !== 1)
      problems.push(key + ": ran " + matches.length + " times");
  }
  for (const row of rows) {
    if (!expected.includes(id(row))) problems.push("unlisted test: " + id(row));
    if (row.status !== "pass") problems.push(row.status + ": " + id(row));
  }
  const total = summary.match(/ℹ tests (\d+)/);
  if (!total || Number(total[1]) !== rows.length)
    problems.push("missing or incomplete test summary");
  for (const kind of ["fail", "cancelled", "skipped", "todo"]) {
    const match = summary.match(new RegExp("ℹ " + kind + " (\\d+)"));
    if (!match || Number(match[1]) !== 0)
      problems.push("test summary " + kind + " is not zero");
  }
  return problems;
}
export function checkFuzz(run: any, known: number[]): string[] {
  const problems: string[] = [];
  if (
    run.start !== 0 ||
    run.seeds !== 200 ||
    Object.values(run.tally ?? {}).reduce(
      (a: number, b) => a + Number(b),
      0,
    ) !== 200
  )
    problems.push("fixed fuzz run is incomplete");
  for (const finding of run.findings ?? []) {
    if (
      finding.status !== "divergent" ||
      finding.classes?.length !== 1 ||
      finding.classes[0] !== "upstream: interpreter vs compiled"
    )
      problems.push(
        "fuzz seed " +
          finding.seed +
          ": " +
          (finding.classes?.join(", ") ?? finding.status),
      );
    else if (!known.includes(finding.seed))
      problems.push("unlisted upstream fuzz difference: " + finding.seed);
  }
  return problems;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = resolve(process.argv[process.argv.indexOf("--out") + 1]);
  const subset = process.argv.includes("--subset");
  const canary = process.argv.includes("--canary");
  const rust = process.argv.includes("--rust");
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const pins = json(new URL("../pins.json", import.meta.url).pathname);
  const expected = json(
    new URL("../baselines/subset-tests.json", import.meta.url).pathname,
  );
  const known = json(
    new URL("../baselines/fuzz-upstream.json", import.meta.url).pathname,
  ).seeds;
  const rows: Row[] = readFileSync(out + "/suite.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const problems = checkTests(
    rows,
    expected,
    readFileSync(out + "/suite.spec.txt", "utf8"),
  );
  problems.push(...checkFuzz(json(out + "/fuzz.json"), known));
  const exits = new Map(
    readFileSync(out + "/exits.txt", "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [name, code] = line.split(" ");
        return [name, Number(code)] as const;
      }),
  );
  const required = [
    "pins",
    "types",
    "suite",
    "fuzz",
    ...(!subset
      ? [
          "upstream-test",
          "upstream-oracle",
          "upstream-compiled",
          "upstream-types",
          "upstream-ssr",
        ]
      : []),
    ...(rust ? ["rust-check", "rust-lower", "rust-project", "rust-test"] : []),
  ];
  for (const step of required)
    if (exits.get(step) !== 0)
      problems.push(step + " exit " + (exits.get(step) ?? "missing"));
  const runners: string[] = [];
  if (!subset)
    for (const name of ["test", "oracle", "compiled", "types", "ssr"]) {
      const log = readFileSync(out + "/upstream-" + name + ".log", "utf8");
      const summary =
        name === "test"
          ? (log.match(/^PASS /gm)?.length ?? 0) +
            " pass, " +
            (log.match(/^FAIL /gm)?.length ?? 0) +
            " fail"
          : log.match(/\d+ pass, \d+ fail(?:, \d+ skip)?/g)?.at(-1);
      runners.push(name + ": " + summary);
      if (!summary || (!canary && summary !== pins.upstreamBaseline[name]))
        problems.push("upstream " + name + " summary differs from pin");
    }
  const fuzz = json(out + "/fuzz.json");
  const text = [
    "# " + (subset ? "Frontend subset" : "Full pinned check"),
    "",
    "Result: " + (problems.length ? "FAIL" : "PASS"),
    "Tests: " +
      rows.length +
      ", pass " +
      rows.filter((r) => r.status === "pass").length +
      ", fail " +
      rows.filter((r) => r.status === "fail").length,
    "Fuzz: " + JSON.stringify(fuzz.tally),
    ...runners,
    "",
    ...problems.map((p) => "- " + p),
    "",
    "Upstream failures are not waived. S-store-8 is documented in docs/UPSTREAM-ISSUES.md.",
    "",
  ].join("\n");
  writeFileSync(out + "/REPORT.md", text);
  console.log(text);
  process.exitCode = problems.length ? 1 : 0;
}
