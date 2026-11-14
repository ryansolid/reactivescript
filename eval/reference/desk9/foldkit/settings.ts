import { Array, Effect, Option, Schema, pipe } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import { request } from './request'

// MODEL

const Theme = Schema.Literals(['light', 'dark'])
const Density = Schema.Literals(['comfortable', 'compact'])
const Settings = Schema.Struct({ name: Schema.String, theme: Theme, density: Density })
type Settings = typeof Settings.Type

// The draft is seeded once from the loaded settings; after that it is the user's.
export const LoadState = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Loaded: { saved: Settings, draft: Settings },
})

export const Model = Schema.Struct({
  loadSeq: Schema.Number,
  load: LoadState,
  seq: Schema.Number,
  saving: Schema.Array(Schema.Struct({ seq: Schema.Number, value: Settings })),
  confirmed: Schema.Number,
  maybeSaveError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoad: { seq: Schema.Number, settings: Settings },
  FailedLoad: { seq: Schema.Number, error: Schema.String },
  ClickedRetryLoad: {},
  UpdatedName: { value: Schema.String },
  ClickedTheme: { theme: Theme },
  ClickedDensityToggle: {},
  ClickedSave: {},
  SucceededSave: { seq: Schema.Number, settings: Settings },
  FailedSave: { seq: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const Load = Command.define('Load', {
  args: { seq: Schema.Number },
  messages: [Message.SucceededLoad, Message.FailedLoad],
  execute: ({ seq }) =>
    request(() => Api.loadSettings()).pipe(
      Effect.map(settings => Message.SucceededLoad({ seq, settings })),
      Effect.catch(error => Effect.succeed(Message.FailedLoad({ seq, error }))),
    ),
})

const Save = Command.define('Save', {
  args: { seq: Schema.Number, settings: Settings },
  messages: [Message.SucceededSave, Message.FailedSave],
  execute: ({ seq, settings }) =>
    request(() => Api.saveSettings(settings)).pipe(
      Effect.map(saved => Message.SucceededSave({ seq, settings: saved })),
      Effect.catch(error => Effect.succeed(Message.FailedSave({ seq, error }))),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: { loadSeq: 1, load: LoadState.Loading(), seq: 1, saving: [], confirmed: 0, maybeSaveError: Option.none() },
  commands: [Load({ seq: 1 })],
})

// UPDATE

const nameError = (name: string): string =>
  name.length === 0
    ? 'Display name is required'
    : name.length > 20
      ? `Display name must be at most 20 characters, not ${name.length}`
      : ''

const editDraft = (model: Model, f: (draft: Settings) => Settings): Model =>
  modifyFields(model, {
    load: load => (load._tag === 'Loaded' ? LoadState.Loaded({ saved: load.saved, draft: f(load.draft) }) : load),
  })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoad: ({ seq, settings }) =>
      seq === model.loadSeq
        ? { model: modifyFields(model, { load: () => LoadState.Loaded({ saved: settings, draft: settings }) }) }
        : { model },

    FailedLoad: ({ seq, error }) =>
      seq === model.loadSeq ? { model: modifyFields(model, { load: () => LoadState.Failed({ error }) }) } : { model },

    ClickedRetryLoad: () => {
      const loadSeq = model.loadSeq + 1
      return { model: modifyFields(model, { loadSeq: () => loadSeq }), commands: [Load({ seq: loadSeq })] }
    },

    UpdatedName: ({ value }) => ({ model: editDraft(model, draft => ({ ...draft, name: value })) }),

    ClickedTheme: ({ theme }) => ({ model: editDraft(model, draft => ({ ...draft, theme })) }),

    ClickedDensityToggle: () => ({
      model: editDraft(model, draft => ({ ...draft, density: draft.density === 'compact' ? 'comfortable' : 'compact' })),
    }),

    ClickedSave: () => {
      if (model.load._tag !== 'Loaded' || nameError(model.load.draft.name) !== '') {
        return { model }
      }
      const draft = model.load.draft
      return {
        model: modifyFields(model, {
          seq: seq => seq + 1,
          maybeSaveError: () => Option.none(),
          saving: Array.append({ seq: model.seq, value: draft }),
        }),
        commands: [Save({ seq: model.seq, settings: draft })],
      }
    },

    SucceededSave: ({ seq, settings }) => {
      const isNewest = seq > model.confirmed
      return {
        model: modifyFields(model, {
          saving: Array.filter(saving => saving.seq !== seq),
          confirmed: confirmed => (isNewest ? seq : confirmed),
          load: load =>
            isNewest && load._tag === 'Loaded' ? LoadState.Loaded({ saved: settings, draft: load.draft }) : load,
        }),
      }
    },

    FailedSave: ({ seq, error }) => ({
      model: modifyFields(model, {
        saving: Array.filter(saving => saving.seq !== seq),
        maybeSaveError: () => Option.some(error),
      }),
    }),
  })

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const loadedView = (model: Model, saved: Settings, draft: Settings, h: HtmlBuilder<Message>): Html => {
  const maybeGuess = pipe(
    model.saving,
    Array.filter(saving => saving.seq > model.confirmed),
    Array.last,
  )
  const shown = Option.match(maybeGuess, { onNone: () => saved, onSome: guess => guess.value })
  const error = nameError(draft.name)
  return h.main([], [
    h.p(
      [testId(h, 'saved')],
      [`Saved: ${shown.name} · ${shown.theme} · ${shown.density}${Option.isSome(maybeGuess) ? ' (saving…)' : ''}`],
    ),
    Option.match(model.maybeSaveError, {
      onNone: () => h.empty,
      onSome: saveError => h.p([testId(h, 'save-error')], [`Save failed: ${saveError}`]),
    }),
    h.div([], [
      h.label([], [
        'Display name ',
        h.input([testId(h, 'name'), h.Value(draft.name), h.OnInput(value => Message.UpdatedName({ value }))]),
      ]),
      h.small([testId(h, 'name-count')], [`${draft.name.length}/20`]),
      error === '' ? h.empty : h.p([testId(h, 'name-error')], [error]),
      h.div([], [
        h.span([], [`Theme: ${draft.theme}`]),
        h.button([testId(h, 'theme-light'), h.OnClick(Message.ClickedTheme({ theme: 'light' }))], ['light']),
        h.button([testId(h, 'theme-dark'), h.OnClick(Message.ClickedTheme({ theme: 'dark' }))], ['dark']),
        h.button([testId(h, 'density-toggle'), h.OnClick(Message.ClickedDensityToggle())], ['Toggle density']),
        h.p([testId(h, 'preview')], [`Preview: ${draft.theme} / ${draft.density}`]),
      ]),
      h.button([testId(h, 'save'), h.OnClick(Message.ClickedSave())], ['Save']),
    ]),
  ])
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => h.p([testId(h, 'load')], ['Loading settings…']),
    Failed: ({ error }) =>
      h.section([], [
        h.p([testId(h, 'load')], [`Could not load settings: ${error}`]),
        h.button([testId(h, 'retry-load'), h.OnClick(Message.ClickedRetryLoad())], ['Retry']),
      ]),
    Loaded: ({ saved, draft }) => loadedView(model, saved, draft, h),
  }),
)
