import type { Comment, IssueDetail as Detail } from "./api";
import { errorMessage } from "./errors";
import CommentList, { type Sending } from "./CommentList";
import Labels from "./Labels";
import Related from "./Related";

type Props = {
  id: number;
  visit: number;
  user: string;
  detail: Detail | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onAssign: () => void;
  assignError: string | null;
  titleInput: string;
  onTitleInput: (title: string) => void;
  onRename: () => void;
  renameError: string | null;
  onClose: () => void;
  closeError: string | null;
  comments: Comment[] | undefined;
  commentsPending: boolean;
  commentsError: unknown;
  sending: Sending[];
  commentInput: string;
  onCommentInput: (text: string) => void;
  onPost: () => void;
  postError: string | null;
  onOpenHelp: (query: string, id: number) => void;
};

export default function IssueDetail(p: Props) {
  let body;
  if (p.loading) body = <p>loading #{p.id}</p>;
  else if (p.error || !p.detail) body = <p>detail error: {errorMessage(p.error)}</p>;
  else
    body = (
      <>
        <h2>
          #{p.detail.id} {p.detail.title}
        </h2>
        <p>{p.detail.body}</p>
        <Related title={p.detail.title} onOpen={p.onOpenHelp} />
      </>
    );
  return (
    <>
      {body}
      <button type="button" data-testid="retry" onClick={p.onRetry}>
        retry
      </button>
      <button type="button" data-testid="assign" onClick={p.onAssign}>
        assign to {p.user}
      </button>
      {p.assignError && <p data-testid="assign-error">{p.assignError}</p>}
      <div>
        <input data-testid="title-input" value={p.titleInput} onChange={e => p.onTitleInput(e.target.value)} />
        <button type="button" data-testid="rename" onClick={p.onRename}>
          rename
        </button>
        {p.renameError && <p>rename error: {p.renameError}</p>}
      </div>
      <button type="button" data-testid="close" onClick={p.onClose}>
        close
      </button>
      {p.closeError && <p>close error: {p.closeError}</p>}
      <Labels id={p.id} visit={p.visit} />
      <div data-testid="comments">
        <CommentList comments={p.comments} isPending={p.commentsPending} error={p.commentsError} sending={p.sending} />
      </div>
      <input data-testid="comment-input" value={p.commentInput} onChange={e => p.onCommentInput(e.target.value)} />
      <button type="button" data-testid="post" onClick={p.onPost}>
        post
      </button>
      {p.postError && <p>post error: {p.postError}</p>}
    </>
  );
}
