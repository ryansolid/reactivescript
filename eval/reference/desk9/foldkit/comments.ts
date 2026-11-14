import { Array, Effect, Match, Option, Schema, pipe } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import { request } from './request'

// The selected issue's comments. The model lives as long as the issues page, so posts still in the air are shown
// after whatever the issue's comments answer, also after the issue was selected again.

// MODEL

const Comment = Schema.Struct({ author: Schema.String, text: Schema.String })
type Comment = typeof Comment.Type

export const CommentsState = defineTaggedUnion({
  Loading: {},
  Loaded: { comments: Schema.Array(Comment) },
  Failed: { error: Schema.String },
})

const Sending = Schema.Struct({ seq: Schema.Number, issueId: Schema.Number, comment: Comment })

const PostError = Schema.Struct({ issueId: Schema.Number, message: Schema.String })

export const Model = Schema.Struct({
  maybeIssueId: Schema.Option(Schema.Number),
  loadSeq: Schema.Number,
  comments: CommentsState,
  input: Schema.String,
  seq: Schema.Number,
  sending: Schema.Array(Sending),
  lastPost: Schema.Number,
  maybeError: Schema.Option(PostError),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchComments: { seq: Schema.Number, comments: Schema.Array(Comment) },
  FailedFetchComments: { seq: Schema.Number, error: Schema.String },
  UpdatedInput: { value: Schema.String },
  ClickedPost: {},
  SucceededAddComment: { seq: Schema.Number, issueId: Schema.Number, comment: Comment },
  FailedAddComment: { seq: Schema.Number, issueId: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const FetchComments = Command.define('FetchComments', {
  args: { seq: Schema.Number, issueId: Schema.Number },
  messages: [Message.SucceededFetchComments, Message.FailedFetchComments],
  execute: ({ seq, issueId }) =>
    request(() => Api.fetchComments(issueId)).pipe(
      Effect.map(comments => Message.SucceededFetchComments({ seq, comments })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchComments({ seq, error }))),
    ),
})

const AddComment = Command.define('AddComment', {
  args: { seq: Schema.Number, issueId: Schema.Number, author: Schema.String, text: Schema.String },
  messages: [Message.SucceededAddComment, Message.FailedAddComment],
  execute: ({ seq, issueId, author, text }) =>
    request(() => Api.addComment(issueId, author, text)).pipe(
      Effect.map(comment => Message.SucceededAddComment({ seq, issueId, comment })),
      Effect.catch(error => Effect.succeed(Message.FailedAddComment({ seq, issueId, error }))),
    ),
})

// INIT

export const init = (): Model => ({
  maybeIssueId: Option.none(),
  loadSeq: 0,
  comments: CommentsState.Loading(),
  input: '',
  seq: 1,
  sending: [],
  lastPost: 0,
  maybeError: Option.none(),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

/** Shows the comments of `issueId`, newly selected. */
export const select = (model: Model, issueId: number): UpdateReturn => {
  const loadSeq = model.loadSeq + 1
  return {
    model: modifyFields(model, {
      maybeIssueId: () => Option.some(issueId),
      loadSeq: () => loadSeq,
      comments: () => CommentsState.Loading(),
      maybeError: () => Option.none(),
    }),
    commands: [FetchComments({ seq: loadSeq, issueId })],
  }
}

/** A comment the server took on `issueId`: it joins the comments on screen. */
const withServerComment = (model: Model, issueId: number, comment: Comment): Model =>
  modifyFields(model, {
    comments: current =>
      Option.contains(model.maybeIssueId, issueId) && current._tag === 'Loaded'
        ? CommentsState.Loaded({ comments: Array.append(current.comments, comment) })
        : current,
  })

const settlePost = (model: Model, seq: number): Model =>
  modifyFields(model, { sending: Array.filter(sending => sending.seq !== seq) })

export const update = (model: Model, message: Message, context: Readonly<{ user: string }>) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchComments: ({ seq, comments }) =>
      seq === model.loadSeq
        ? { model: modifyFields(model, { comments: () => CommentsState.Loaded({ comments }) }) }
        : { model },

    FailedFetchComments: ({ seq, error }) =>
      seq === model.loadSeq ? { model: modifyFields(model, { comments: () => CommentsState.Failed({ error }) }) } : { model },

    UpdatedInput: ({ value }) => ({ model: modifyFields(model, { input: () => value }) }),

    ClickedPost: () =>
      Option.match(model.maybeIssueId, {
        onNone: () => ({ model }),
        onSome: issueId => {
          const comment = { author: context.user, text: model.input }
          if (comment.text === '') {
            return { model }
          }
          return {
            model: modifyFields(model, {
              seq: seq => seq + 1,
              lastPost: () => model.seq,
              maybeError: () => Option.none(),
              input: () => '',
              sending: Array.append({ seq: model.seq, issueId, comment }),
            }),
            commands: [AddComment({ seq: model.seq, issueId, ...comment })],
          }
        },
      }),

    SucceededAddComment: ({ seq, issueId, comment }) => ({
      model: withServerComment(settlePost(model, seq), issueId, comment),
    }),

    // Only the newest post reports its failure.
    FailedAddComment: ({ seq, issueId, error }) => ({
      model: modifyFields(settlePost(model, seq), {
        maybeError: current => (model.lastPost === seq ? Option.some({ issueId, message: error }) : current),
      }),
    }),
  })

/** An answer to a post made on an earlier visit of the issues page: the comment the server took still holds. */
export const learnFromEarlierVisit = (model: Model, message: Message): Model =>
  Match.value(message).pipe(
    Match.tag('SucceededAddComment', ({ issueId, comment }) => withServerComment(model, issueId, comment)),
    Match.orElse(() => model),
  )

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const commentList = (model: Model, issueId: number, comments: ReadonlyArray<Comment>, h: HtmlBuilder<Message>): Html =>
  h.ul([], [
    ...Array.map(comments, comment => h.li([testId(h, 'comment')], [`${comment.author}: ${comment.text}`])),
    ...pipe(
      model.sending,
      Array.filter(sending => sending.issueId === issueId),
      Array.map(({ seq, comment }) =>
        h.keyed('li')(`sending-${seq}`, [testId(h, 'comment')], [`${comment.author}: ${comment.text} (sending…)`]),
      ),
    ),
  ])

const commentsState = (model: Model, issueId: number, h: HtmlBuilder<Message>): Html =>
  CommentsState.match(model.comments, {
    Loading: () => h.p([], ['loading comments']),
    Failed: ({ error }) => h.p([], [`comments error: ${error}`]),
    Loaded: ({ comments }) => commentList(model, issueId, comments, h),
  })

const errorLine = (model: Model, issueId: number, h: HtmlBuilder<Message>): Html =>
  pipe(
    model.maybeError,
    Option.filter(error => error.issueId === issueId),
    Option.match({ onNone: () => h.empty, onSome: error => h.p([], [`post error: ${error.message}`]) }),
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Option.match(model.maybeIssueId, {
    onNone: () => h.empty,
    onSome: issueId =>
      h.div([], [
        h.div([testId(h, 'comments')], [commentsState(model, issueId, h)]),
        h.input([testId(h, 'comment-input'), h.Value(model.input), h.OnInput(value => Message.UpdatedInput({ value }))]),
        h.button([testId(h, 'post'), h.OnClick(Message.ClickedPost())], ['post']),
        errorLine(model, issueId, h),
      ]),
  }),
)
