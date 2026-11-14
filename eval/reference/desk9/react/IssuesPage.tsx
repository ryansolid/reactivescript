import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addComment, assign, closeIssue, fetchComments, fetchIssue, fetchIssues, renameIssue } from "./api";
import type { Comment, Issue, IssueDetail as Detail } from "./api";
import { errorIn, errorMessage, type VisitError } from "./errors";
import IssueList from "./IssueList";
import IssueDetail from "./IssueDetail";
import type { Sending } from "./CommentList";

type Filter = "open" | "closed";
// Where a write was started: the detail's buttons or a list row's. Each place reports its own failures.
type Origin = "detail" | "row";
// a write still in the air: `seq` orders writes to the same issue, the latest one is what the issue shows
type Guess<T> = { seq: number; value: T };
type Guesses<T> = Record<number, Guess<T>[]>;

const latest = <T,>(guesses: Guesses<T>, id: number): T | undefined => guesses[id]?.at(-1)?.value;
const addGuess = <T,>(prev: Guesses<T>, id: number, g: Guess<T>): Guesses<T> => ({ ...prev, [id]: [...(prev[id] ?? []), g] });
const dropGuess = <T,>(prev: Guesses<T>, id: number, seq: number): Guesses<T> => {
  const rest = (prev[id] ?? []).filter(g => g.seq !== seq);
  const next = { ...prev };
  if (rest.length) next[id] = rest;
  else delete next[id];
  return next;
};

type Props = {
  /** told the number of open issues whenever the open list shows settled rows */
  onOpenCount: (n: number) => void;
  onOpenHelp: (query: string, id: number) => void;
};

export default function IssuesPage({ onOpenCount, onOpenHelp }: Props) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState("guest");
  const [filter, setFilter] = useState<Filter>("open");
  const [selected, setSelected] = useState<number | null>(null);
  // counts selections: the detail's errors and inputs belong to one selection
  const [visit, setVisit] = useState(0);
  const seqRef = useRef(0);
  const nextSeq = () => ++seqRef.current;

  // assignments in the air, and the newest one confirmed per issue (an older answer must not overwrite it)
  const [assigning, setAssigning] = useState<Guesses<string>>({});
  const [assignError, setAssignError] = useState<VisitError | null>(null);
  const lastAssignRef = useRef(0);
  const confirmedAssignRef = useRef<Record<number, number>>({});

  const [renaming, setRenaming] = useState<Guesses<string>>({});
  const [renameError, setRenameError] = useState<VisitError | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const lastRenameRef = useRef(0);
  const confirmedRenameRef = useRef<Record<number, number>>({});

  // closes in the air, by issue id, with how many are out
  const [closing, setClosing] = useState<Record<number, number>>({});
  const [closeError, setCloseError] = useState<VisitError | null>(null);
  const lastCloseRef = useRef(0);

  const [sending, setSending] = useState<Sending[]>([]);
  const [postError, setPostError] = useState<VisitError | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const lastPostRef = useRef(0);

  // the newest row action (assign or close) is the one whose failure the row error reports
  const [rowError, setRowError] = useState<string | null>(null);
  const lastRowActionRef = useRef(0);

  const list = useQuery({ queryKey: ["issues", filter], queryFn: () => fetchIssues(filter) });

  const detail = useQuery({
    queryKey: ["issue", selected],
    queryFn: async () => {
      const id = selected as number;
      const d = await fetchIssue(id);
      if (d === null) throw new Error(`issue #${id} not found`);
      return d;
    },
    enabled: selected !== null,
  });

  const comments = useQuery({
    queryKey: ["comments", selected],
    queryFn: () => fetchComments(selected as number),
    enabled: selected !== null,
  });

  // the server's answers with the writes still in the air laid over them
  const shownIssues = list.data
    ?.filter(issue => !(filter === "open" && closing[issue.id]))
    .map(issue => ({
      ...issue,
      title: latest(renaming, issue.id) ?? issue.title,
      assignee: latest(assigning, issue.id) ?? issue.assignee,
    }));
  const shownDetail = detail.data && { ...detail.data, title: latest(renaming, detail.data.id) ?? detail.data.title };

  // the open list as shown (closes in the air already out of it) is the tab's count; the closed list, loads and
  // failures leave the count as it was
  const openCount = filter === "open" && !list.isFetching && shownIssues ? shownIssues.length : null;
  useEffect(() => {
    if (openCount !== null) onOpenCount(openCount);
  }, [openCount, onOpenCount]);

  const select = (id: number) => {
    setSelected(id);
    setVisit(v => v + 1);
    setTitleInput("");
  };

  /** start a row action: it clears the row error, and only the newest one reports its failure */
  const startRowAction = () => {
    const seq = nextSeq();
    lastRowActionRef.current = seq;
    setRowError(null);
    return (e: unknown) => {
      if (lastRowActionRef.current === seq) setRowError(errorMessage(e));
    };
  };

  const doAssign = async (id: number, who: string, origin: Origin) => {
    const seq = nextSeq();
    let reportFailure: (e: unknown) => void;
    if (origin === "row") reportFailure = startRowAction();
    else {
      lastAssignRef.current = seq;
      setAssignError(null);
      reportFailure = e => {
        if (lastAssignRef.current === seq) setAssignError({ visit, message: errorMessage(e) });
      };
    }
    setAssigning(prev => addGuess(prev, id, { seq, value: who }));
    try {
      const res = await assign(id, who);
      if ((confirmedAssignRef.current[id] ?? 0) < seq) {
        confirmedAssignRef.current[id] = seq;
        queryClient.setQueriesData<Issue[]>({ queryKey: ["issues"] }, old =>
          old?.map(i => (i.id === id ? { ...i, assignee: res.assignee } : i)),
        );
      }
    } catch (e) {
      reportFailure(e);
    } finally {
      setAssigning(prev => dropGuess(prev, id, seq));
    }
  };

  const doRename = async (id: number, title: string) => {
    const seq = nextSeq();
    lastRenameRef.current = seq;
    setRenameError(null);
    setRenaming(prev => addGuess(prev, id, { seq, value: title }));
    try {
      const res = await renameIssue(id, title);
      if ((confirmedRenameRef.current[id] ?? 0) < seq) {
        confirmedRenameRef.current[id] = seq;
        queryClient.setQueriesData<Issue[]>({ queryKey: ["issues"] }, old =>
          old?.map(i => (i.id === id ? { ...i, title: res.title } : i)),
        );
        queryClient.setQueryData<Detail>(["issue", id], old => (old ? { ...old, title: res.title } : old));
      }
    } catch (e) {
      if (lastRenameRef.current === seq) setRenameError({ visit, message: errorMessage(e) });
    } finally {
      setRenaming(prev => dropGuess(prev, id, seq));
    }
  };

  const doClose = async (id: number, origin: Origin) => {
    const seq = nextSeq();
    let reportFailure: (e: unknown) => void;
    if (origin === "row") reportFailure = startRowAction();
    else {
      lastCloseRef.current = seq;
      setCloseError(null);
      reportFailure = e => {
        if (lastCloseRef.current === seq) setCloseError({ visit, message: errorMessage(e) });
      };
    }
    setClosing(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    try {
      await closeIssue(id);
      queryClient.setQueryData<Issue[]>(["issues", "open"], old => old?.filter(i => i.id !== id));
    } catch (e) {
      reportFailure(e);
    } finally {
      setClosing(prev => {
        const next = { ...prev };
        if ((next[id] ?? 0) > 1) next[id] -= 1;
        else delete next[id];
        return next;
      });
    }
  };

  const doPost = async (id: number, author: string, text: string) => {
    const seq = nextSeq();
    lastPostRef.current = seq;
    setPostError(null);
    setCommentInput("");
    setSending(prev => [...prev, { seq, issueId: id, author, text }]);
    try {
      const res = await addComment(id, author, text);
      queryClient.setQueryData<Comment[]>(["comments", id], old => (old ? [...old, res] : old));
    } catch (e) {
      if (lastPostRef.current === seq) setPostError({ visit, message: errorMessage(e) });
    } finally {
      setSending(prev => prev.filter(p => p.seq !== seq));
    }
  };

  return (
    <div style={{ display: "flex", gap: "2rem" }}>
      <section>
        <label>
          user <input data-testid="user" value={user} onChange={e => setUser(e.target.value)} />
        </label>
        <div>
          <button type="button" data-testid="filter-open" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
            open
          </button>
          <button type="button" data-testid="filter-closed" aria-pressed={filter === "closed"} onClick={() => setFilter("closed")}>
            closed
          </button>
        </div>
        <div data-testid="list">
          <IssueList
            filter={filter}
            issues={shownIssues}
            isPending={list.isPending}
            error={list.error}
            selected={selected}
            user={user}
            onSelect={select}
            onRowAssign={id => void doAssign(id, user, "row")}
            onRowClose={id => void doClose(id, "row")}
          />
        </div>
        {rowError && <p data-testid="row-error">row error: {rowError}</p>}
      </section>
      <section data-testid="detail">
        {selected === null ? (
          <p>select an issue</p>
        ) : (
          <IssueDetail
            id={selected}
            visit={visit}
            user={user}
            detail={shownDetail}
            loading={detail.isFetching || detail.isPending}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            onAssign={() => void doAssign(selected, user, "detail")}
            assignError={errorIn(assignError, visit)}
            titleInput={titleInput}
            onTitleInput={setTitleInput}
            onRename={() => {
              if (titleInput !== "") void doRename(selected, titleInput);
            }}
            renameError={errorIn(renameError, visit)}
            onClose={() => void doClose(selected, "detail")}
            closeError={errorIn(closeError, visit)}
            comments={comments.data}
            commentsPending={comments.isPending}
            commentsError={comments.error}
            sending={sending.filter(p => p.issueId === selected)}
            commentInput={commentInput}
            onCommentInput={setCommentInput}
            onPost={() => {
              if (commentInput !== "") void doPost(selected, user, commentInput);
            }}
            postError={errorIn(postError, visit)}
            onOpenHelp={onOpenHelp}
          />
        )}
      </section>
    </div>
  );
}
