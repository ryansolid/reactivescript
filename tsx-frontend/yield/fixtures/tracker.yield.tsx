import { $event, $memo, $optimistic, $signal, $store, attempt, component, For, Show, view } from "solid-yield";
import type { Handler, Props, Source } from "solid-yield";
import { assignIssue } from "./api";

type Issue = { id: number; title: string; assignee: string };

export default component(function* Tracker() {
  const [issues, setIssues] = yield* $store({
    list: [
      { id: 1, title: "Crash on save", assignee: "" },
      { id: 2, title: "Slow search", assignee: "ana" },
      { id: 3, title: "Typo in footer", assignee: "" },
    ],
  });
  const [mode, setMode] = yield* $signal("all");
  const [claiming, setClaiming] = yield* $optimistic(0);
  const [status, setStatus] = yield* $signal("");

  const visible = yield* $memo(function* () {
    const current = yield* mode;
    return (yield* issues.list).filter((issue) => current === "all" || issue.assignee === "");
  });
  const unassigned = yield* $memo(function* () {
    return (yield* issues.list).filter((issue) => issue.assignee === "").length;
  });

  const toggle = $event(function* () {
    yield* setMode((yield* mode) === "all" ? "open" : "all");
  });
  // Show the claim at once; commit the server's answer, or roll back and explain.
  const claim = $event(function* (id: number) {
    yield* setClaiming(id);
    const owner = yield* attempt(
      () => assignIssue(id),
      function* () {
        yield* setStatus("Could not assign #" + id);
      },
    );
    if (owner !== undefined) {
      yield* setIssues((draft) => {
        draft.list[draft.list.findIndex((candidate) => candidate.id === id)].assignee = owner;
      });
      yield* setStatus("");
    }
  });

  return view(function* () {
    return (
      <section>
        <button onClick={yield* toggle}>Filter: {yield* mode}</button>
        <b>{yield* unassigned} open</b>
        {yield* Show({
          when: function* () {
            return (yield* visible).length > 0;
          },
          fallback: function* () {
            return <i>Nothing to triage</i>;
          },
          children: function* () {
            return (
              <>
                {yield* For({
                  each: visible,
                  children: function* (issue) {
                    return view(function* () {
                      return (
                        <>
                          {yield* IssueRow({
                            issue,
                            claiming: function* () {
                              return (yield* claiming) === (yield* issue.id);
                            },
                            onAssign: claim,
                          })}
                        </>
                      );
                    });
                  },
                })}
              </>
            );
          },
        })}
        <em>{yield* status}</em>
      </section>
    );
  });
});

const IssueRow = component(function* IssueRow(
  props: Props<{ issue: Source<Issue>; claiming: Source<boolean>; onAssign: Handler<[number]> }>,
) {
  const take = $event(function* () {
    yield* props.onAssign(yield* props.issue.id);
  });
  return view(function* () {
    return (
      <p>
        {yield* props.issue.title}: {(yield* props.claiming) ? "me" : (yield* props.issue.assignee) || "nobody"}
        <button onClick={yield* take}>take</button>
      </p>
    );
  });
});
