// node:test reporter: one JSON line per finished test (pass/fail), for scripts/report.ts. Suites are included as
// ordinary entries; a failing file that never registers tests appears as one failing entry named after the file.
export default async function* jsonlReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data;
    const error = event.type === "test:fail" ? d.details?.error : undefined;
    const message = error ? String(error.cause?.message ?? error.message ?? error).split("\n").slice(0, 6).join("\n") : undefined;
    yield JSON.stringify({
      status: event.type === "test:pass" ? (d.skip ? "skip" : d.todo ? "todo" : "pass") : "fail",
      file: d.file ? d.file.split("/frontend/").at(-1) : undefined,
      line: d.line,
      column: d.column,
      name: d.name,
      nesting: d.nesting,
      error: message,
    }) + "\n";
  }
}
