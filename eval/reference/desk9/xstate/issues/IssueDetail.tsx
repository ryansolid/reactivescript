import type { SnapshotFrom } from "xstate";
import { AppActor } from "../appMachine";
import { issuesMachine, sendingComments, shownLabels, shownTitle } from "./issuesMachine";
import type { IssuesActor } from "./IssuesPage";

type Snapshot = SnapshotFrom<typeof issuesMachine>;
type Props = { state: Snapshot; send: IssuesActor["send"] };

export default function IssueDetail({ state, send, id }: Props & { id: number }) {
  const { context } = state;
  const { errors } = context;
  return (
    <>
      {state.matches({ detail: { selected: { issue: "loading" } } }) ? (
        <p>loading #{id}</p>
      ) : state.matches({ detail: { selected: { issue: "notFound" } } }) ? (
        <p>detail error: issue #{id} not found</p>
      ) : state.matches({ detail: { selected: { issue: "failed" } } }) ? (
        <p>detail error: {context.detailError}</p>
      ) : (
        <>
          <h2>
            #{id} {shownTitle(context, id)}
          </h2>
          <p>{context.detail?.body}</p>
          <Related state={state} />
        </>
      )}
      <button type="button" data-testid="retry" onClick={() => send({ type: "detail.retry" })}>
        retry
      </button>
      <div>
        <button type="button" data-testid="assign" onClick={() => send({ type: "assign", issueId: id, origin: "detail" })}>
          assign to {context.user}
        </button>
        {errors.assign && <p>assign error: {errors.assign}</p>}
      </div>
      <div>
        <input data-testid="title-input" value={context.titleInput} onChange={e => send({ type: "title.change", value: e.target.value })} />
        <button type="button" data-testid="rename" onClick={() => send({ type: "rename" })}>
          rename
        </button>
        {errors.rename && <p>rename error: {errors.rename}</p>}
      </div>
      <div>
        <button type="button" data-testid="close" onClick={() => send({ type: "close", issueId: id, origin: "detail" })}>
          close
        </button>
        {errors.close && <p>close error: {errors.close}</p>}
      </div>
      <Labels state={state} send={send} />
      <Comments state={state} send={send} />
    </>
  );
}

/** help related to the issue: the first hits of a search for its title */
function Related({ state }: { state: Snapshot }) {
  const desk = AppActor.useActorRef();
  const { related, relatedError } = state.context;
  return (
    <div data-testid="related">
      {state.matches({ detail: { selected: { issue: { loaded: "relatedFailed" } } } }) ? (
        <p>related help failed: {relatedError}</p>
      ) : !state.matches({ detail: { selected: { issue: { loaded: "related" } } } }) || !related ? (
        <p>finding related help</p>
      ) : related.hits.length === 0 ? (
        <p>no related help</p>
      ) : (
        <ul>
          {related.hits.slice(0, 3).map(hit => (
            <li key={hit.id}>
              <button
                type="button"
                data-testid="related-hit"
                onClick={() => desk.send({ type: "help.open", query: related.query, selected: hit.id })}
              >
                {hit.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Labels({ state, send }: Props) {
  const { context } = state;
  const labels = shownLabels(context);
  return (
    <div>
      <div data-testid="labels">
        {state.matches({ detail: { selected: { labels: "failed" } } }) ? (
          <p>labels error: {context.labelsError}</p>
        ) : !labels ? (
          <p>loading labels</p>
        ) : (
          <ul>
            {labels.map(label => (
              <li key={label}>
                <span data-testid="label">{label}</span>{" "}
                <button type="button" data-testid="remove-label" onClick={() => send({ type: "label.remove", label })}>
                  remove {label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input data-testid="label-input" value={context.labelInput} onChange={e => send({ type: "label.change", value: e.target.value })} />
      <button type="button" data-testid="add-label" onClick={() => send({ type: "label.add" })}>
        add label
      </button>
      {context.errors.label && <p>label error: {context.errors.label}</p>}
    </div>
  );
}

function Comments({ state, send }: Props) {
  const { context } = state;
  return (
    <div>
      <div data-testid="comments">
        {state.matches({ detail: { selected: { comments: "failed" } } }) ? (
          <p>comments error: {context.commentsError}</p>
        ) : !context.comments ? (
          <p>loading comments</p>
        ) : (
          <ul>
            {context.comments.map((c, i) => (
              <li key={i} data-testid="comment">
                {c.author}: {c.text}
              </li>
            ))}
            {sendingComments(context).map(p => (
              <li key={`sending-${p.seq}`} data-testid="comment">
                {p.author}: {p.text} (sending…)
              </li>
            ))}
          </ul>
        )}
      </div>
      <input data-testid="comment-input" value={context.commentInput} onChange={e => send({ type: "comment.change", value: e.target.value })} />
      <button type="button" data-testid="post" onClick={() => send({ type: "post" })}>
        post
      </button>
      {context.errors.post && <p>post error: {context.errors.post}</p>}
    </div>
  );
}
