import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addLabel, fetchLabels, removeLabel } from "./api";
import { errorIn, errorMessage, type VisitError } from "./errors";

// a label change in the air, on one issue
type Change = { seq: number; issueId: number; kind: "add" | "remove"; label: string };

/** the labels as the server answered them, with the changes still in the air laid over them in the order they started */
const withChanges = (labels: string[], changes: Change[]) =>
  changes.reduce(
    (ls, c) => (c.kind === "remove" ? ls.filter(l => l !== c.label) : ls.includes(c.label) ? ls : [...ls, c.label]),
    labels,
  );

// Stays mounted while issues are selected one after another, so changes still in the air are laid over whatever the
// issue's labels answer, also after it was selected again.
export default function Labels({ id, visit }: { id: number; visit: number }) {
  const queryClient = useQueryClient();
  const labels = useQuery({ queryKey: ["labels", id], queryFn: () => fetchLabels(id) });
  const [changes, setChanges] = useState<Change[]>([]);
  const [labelError, setLabelError] = useState<VisitError | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const seqRef = useRef(0);

  const shown = labels.data && withChanges(labels.data, changes.filter(c => c.issueId === id));

  const change = async (kind: Change["kind"], label: string) => {
    const seq = ++seqRef.current;
    const issueId = id;
    setLabelError(null);
    setChanges(prev => [...prev, { seq, issueId, kind, label }]);
    try {
      const after = await (kind === "add" ? addLabel(issueId, label) : removeLabel(issueId, label));
      queryClient.setQueryData(["labels", issueId], after);
    } catch (e) {
      // only the newest label change reports its failure
      if (seqRef.current === seq) setLabelError({ visit, message: errorMessage(e) });
    } finally {
      setChanges(prev => prev.filter(c => c.seq !== seq));
    }
  };

  const error = errorIn(labelError, visit);
  return (
    <div>
      <div data-testid="labels">
        {labels.isPending ? (
          <p>loading labels</p>
        ) : labels.isError ? (
          <p>labels error: {errorMessage(labels.error)}</p>
        ) : (
          <ul>
            {shown?.map(l => (
              <li key={l}>
                <span data-testid="label">{l}</span>{" "}
                <button type="button" data-testid="remove-label" onClick={() => void change("remove", l)}>
                  remove {l}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input data-testid="label-input" value={labelInput} onChange={e => setLabelInput(e.target.value)} />
      <button
        type="button"
        data-testid="add-label"
        onClick={() => {
          const label = labelInput;
          if (label === "" || !shown || shown.includes(label)) return;
          setLabelInput("");
          void change("add", label);
        }}
      >
        add label
      </button>
      {error && <p>label error: {error}</p>}
    </div>
  );
}
