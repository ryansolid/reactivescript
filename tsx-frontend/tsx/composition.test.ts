import { test } from "node:test";
import { readFileSync } from "node:fs";
import { traces } from "./test-utils.ts";

const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const composition = fixture("composition.tsx");

test("later-declared children receive live direct and memo props and forward callbacks upward", async () => {
  await traces(composition, fixture("composition.rx"), [
    "0/0/10",
    "1/4/10",
    "2/8/10",
    "3/12/10",
    "4/16/10",
  ]);
});

test("callback props can attach directly to onClick or forward through a zero-argument arrow", async () => {
  await traces(
    composition.replace(
      "onClick={() => props.onIncrement()}",
      "onClick={props.onIncrement}",
    ),
    fixture("composition.rx").replace(
      "onClick={() => { props.onIncrement(); }}",
      "onClick={props.onIncrement}",
    ),
    ["0/0/10", "1/4/10", "2/8/10", "3/12/10"],
  );
  await traces(
    composition.replace(
      "onIncrement={incoming.onIncrement}",
      "onIncrement={() => incoming.onIncrement()}",
    ),
    fixture("composition.rx").replace(
      "onIncrement={incoming.onIncrement}",
      "onIncrement={() => { incoming.onIncrement(); }}",
    ),
    ["0/0/10", "1/4/10", "2/8/10", "3/12/10"],
  );
});
