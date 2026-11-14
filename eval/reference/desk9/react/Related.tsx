import { useQuery } from "@tanstack/react-query";
import { search } from "./api";
import { errorMessage } from "./errors";

/** help related to an issue: the first hits of a search for its title */
export default function Related({ title, onOpen }: { title: string; onOpen: (query: string, id: number) => void }) {
  const hits = useQuery({ queryKey: ["related", title], queryFn: () => search(title) });
  return (
    <div data-testid="related">
      {hits.isPending ? (
        <p>finding related help</p>
      ) : hits.isError ? (
        <p>related help failed: {errorMessage(hits.error)}</p>
      ) : hits.data.length === 0 ? (
        <p>no related help</p>
      ) : (
        <ul>
          {hits.data.slice(0, 3).map(h => (
            <li key={h.id}>
              <button type="button" data-testid="related-hit" onClick={() => onOpen(title, h.id)}>
                {h.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
