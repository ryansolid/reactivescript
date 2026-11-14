import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchArchived, restoreCard, type Archived } from "./api";
import { errorMessage } from "./errors";

export default function ArchivePage() {
  const queryClient = useQueryClient();
  const archived = useQuery({ queryKey: ["archived"], queryFn: fetchArchived });
  // restores in the air, each with its own seq so that two restores of one row settle separately
  const [restoring, setRestoring] = useState<{ seq: number; id: number }[]>([]);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const doRestore = async (id: number) => {
    const seq = ++seqRef.current;
    setRestoreError(null);
    setRestoring(prev => [...prev, { seq, id }]);
    try {
      await restoreCard(id);
      queryClient.setQueryData<Archived[]>(["archived"], old => old?.filter(a => a.id !== id));
    } catch (e) {
      setRestoreError(errorMessage(e));
    } finally {
      setRestoring(prev => prev.filter(r => r.seq !== seq));
    }
  };

  const rows = archived.data?.filter(a => !restoring.some(r => r.id === a.id));
  return (
    <section>
      <div data-testid="archived">
        {rows ? (
          <ul>
            {rows.map(a => (
              <li key={a.id}>
                <span data-testid="archived-card">
                  #{a.id} {a.title}
                </span>{" "}
                <button type="button" data-testid="restore" onClick={() => void doRestore(a.id)}>
                  restore
                </button>
              </li>
            ))}
          </ul>
        ) : archived.isError ? (
          <p>archive error: {errorMessage(archived.error)}</p>
        ) : (
          <p>loading archive</p>
        )}
      </div>
      {restoreError !== null && <p data-testid="restore-error">restore error: {restoreError}</p>}
    </section>
  );
}
