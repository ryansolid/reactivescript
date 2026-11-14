import type { Issue } from "./api";
import { errorMessage } from "./errors";

type Props = {
  filter: "open" | "closed";
  issues: Issue[] | undefined;
  isPending: boolean;
  error: unknown;
  selected: number | null;
  user: string;
  onSelect: (id: number) => void;
  onRowAssign: (id: number) => void;
  onRowClose: (id: number) => void;
};

export default function IssueList({ filter, issues, isPending, error, selected, user, onSelect, onRowAssign, onRowClose }: Props) {
  if (isPending) return <p>loading {filter} issues</p>;
  if (error || !issues) return <p>list error: {errorMessage(error)}</p>;
  return (
    <ul>
      {issues.map(issue => (
        <li key={issue.id}>
          <button type="button" data-testid="issue" aria-pressed={issue.id === selected} onClick={() => onSelect(issue.id)}>
            #{issue.id} {issue.title} ({issue.assignee ?? "unassigned"})
          </button>{" "}
          <button type="button" data-testid="row-assign" onClick={() => onRowAssign(issue.id)}>
            assign to {user}
          </button>
          {filter === "open" && (
            <>
              {" "}
              <button type="button" data-testid="row-close" onClick={() => onRowClose(issue.id)}>
                close
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
