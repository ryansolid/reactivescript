import type { Comment } from "./api";
import { errorMessage } from "./errors";

export type Sending = { seq: number; issueId: number; author: string; text: string };

type Props = {
  comments: Comment[] | undefined;
  isPending: boolean;
  error: unknown;
  sending: Sending[];
};

export default function CommentList({ comments, isPending, error, sending }: Props) {
  if (isPending) return <p>loading comments</p>;
  if (error || !comments) return <p>comments error: {errorMessage(error)}</p>;
  return (
    <ul>
      {comments.map((c, i) => (
        <li key={i} data-testid="comment">
          {c.author}: {c.text}
        </li>
      ))}
      {sending.map(p => (
        <li key={`s${p.seq}`} data-testid="comment">
          {p.author}: {p.text} (sending…)
        </li>
      ))}
    </ul>
  );
}
