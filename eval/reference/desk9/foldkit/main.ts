import { Option, Schema } from 'effect'
import { Command, type Runtime, Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Help from './help'
import * as Issues from './issues'
import * as Settings from './settings'

// MODEL

const Tab = Schema.Literals(['issues', 'help', 'settings'])
type Tab = typeof Tab.Type

// Only the open page is kept: leaving a page discards it. Each opening of a page gets a new `pageId`, and answers to
// a page that was left carry an old one.
export const Page = defineTaggedUnion({
  Issues: { model: Issues.Model },
  Help: { model: Help.Model },
  Settings: { model: Settings.Model },
})
type Page = typeof Page.Type

// `maybeOpenCount` is the tab's open-issue count: the last one the issues page showed, kept while other pages are open.
export const Model = Schema.Struct({ pageId: Schema.Number, page: Page, maybeOpenCount: Schema.Option(Schema.Number) })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedTab: { tab: Tab },
  GotIssuesMessage: { pageId: Schema.Number, message: Issues.Message },
  GotHelpMessage: { pageId: Schema.Number, message: Help.Message },
  GotSettingsMessage: { pageId: Schema.Number, message: Settings.Message },
})
export type Message = typeof Message.Type

// INIT

type UpdateReturn = Update.Return<Model, Message>
type UpdateStep = Update.Step<Model, Message>

const toGotIssuesMessage = (pageId: number) => (message: Issues.Message) => Message.GotIssuesMessage({ pageId, message })
const toGotHelpMessage = (pageId: number) => (message: Help.Message) => Message.GotHelpMessage({ pageId, message })
const toGotSettingsMessage = (pageId: number) => (message: Settings.Message) =>
  Message.GotSettingsMessage({ pageId, message })

const openIssues = (model: Model): UpdateReturn => {
  const pageId = model.pageId + 1
  const issuesInit = Issues.init()
  return {
    model: modifyFields(model, { pageId: () => pageId, page: () => Page.Issues({ model: issuesInit.model }) }),
    commands: Command.mapMessages(issuesInit.commands, toGotIssuesMessage(pageId)),
  }
}

const openHelp = (model: Model, query: string, maybeSelected: Option.Option<number>): UpdateReturn => {
  const pageId = model.pageId + 1
  const helpInit = Help.init(query, maybeSelected)
  return {
    model: modifyFields(model, { pageId: () => pageId, page: () => Page.Help({ model: helpInit.model }) }),
    commands: Command.mapMessages(helpInit.commands, toGotHelpMessage(pageId)),
  }
}

const openSettings = (model: Model): UpdateReturn => {
  const pageId = model.pageId + 1
  const settingsInit = Settings.init()
  return {
    model: modifyFields(model, { pageId: () => pageId, page: () => Page.Settings({ model: settingsInit.model }) }),
    commands: Command.mapMessages(settingsInit.commands, toGotSettingsMessage(pageId)),
  }
}

export const init: Runtime.ApplicationInit<Model, Message> = () =>
  openIssues({ pageId: 0, page: Page.Settings({ model: Settings.init().model }), maybeOpenCount: Option.none() })

// UPDATE

const tabOf = (page: Page): Tab =>
  Page.match<Tab>(page, { Issues: () => 'issues', Help: () => 'help', Settings: () => 'settings' })

const readIssues = (model: Model): Option.Option<Issues.Model> =>
  model.page._tag === 'Issues' ? Option.some(model.page.model) : Option.none()

const readIssuesVisit =
  (pageId: number) =>
  (model: Model): Option.Option<Issues.Model> =>
    pageId === model.pageId ? readIssues(model) : Option.none()

const writeIssues = (model: Model, nextIssues: Issues.Model): Model =>
  modifyFields(model, { page: () => Page.Issues({ model: nextIssues }) })

const followOpenCount: UpdateStep = model => ({
  model: modifyFields(model, {
    maybeOpenCount: maybeOpenCount =>
      Option.match(readIssues(model), {
        onNone: () => maybeOpenCount,
        onSome: issues => Option.orElse(Issues.openCount(issues), () => maybeOpenCount),
      }),
  }),
})

const foldIssuesOutMessage = (outMessage: Issues.OutMessage): UpdateStep =>
  Issues.OutMessage.match<UpdateStep>(outMessage, {
    OpenedRelatedHelp:
      ({ query, id }) =>
      model =>
        openHelp(model, query, Option.some(id)),
  })

const foldIssuesMessage = (pageId: number) =>
  Update.foldChild({
    update: Issues.update,
    read: readIssuesVisit(pageId),
    write: writeIssues,
    toParentMessage: toGotIssuesMessage(pageId),
    foldOutMessage: foldIssuesOutMessage,
  })

// A write started on an earlier visit of the issues page may answer on this one: what the server took still shows.
const foldEarlierIssuesMessage = (model: Model) =>
  Update.foldChild({
    update: Issues.learnFromEarlierVisit,
    read: readIssues,
    write: writeIssues,
    toParentMessage: toGotIssuesMessage(model.pageId),
  })

const foldHelpMessage = (pageId: number) =>
  Update.foldChild({
    update: Help.update,
    read: (model: Model) =>
      model.page._tag === 'Help' && pageId === model.pageId ? Option.some(model.page.model) : Option.none(),
    write: (model, nextHelp) => modifyFields(model, { page: () => Page.Help({ model: nextHelp }) }),
    toParentMessage: toGotHelpMessage(pageId),
  })

const foldSettingsMessage = (pageId: number) =>
  Update.foldChild({
    update: Settings.update,
    read: (model: Model) =>
      model.page._tag === 'Settings' && pageId === model.pageId ? Option.some(model.page.model) : Option.none(),
    write: (model, nextSettings) => modifyFields(model, { page: () => Page.Settings({ model: nextSettings }) }),
    toParentMessage: toGotSettingsMessage(pageId),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedTab: ({ tab }) => {
      if (tab === tabOf(model.page)) {
        return { model }
      }
      return tab === 'issues' ? openIssues(model) : tab === 'help' ? openHelp(model, '', Option.none()) : openSettings(model)
    },

    GotIssuesMessage: ({ pageId, message }) =>
      Update.combine(model, [
        stepModel =>
          pageId === stepModel.pageId
            ? foldIssuesMessage(pageId)(stepModel, message)
            : foldEarlierIssuesMessage(stepModel)(stepModel, message),
        followOpenCount,
      ]),

    GotHelpMessage: ({ pageId, message }) => foldHelpMessage(pageId)(model, message),

    GotSettingsMessage: ({ pageId, message }) => foldSettingsMessage(pageId)(model, message),
  })

// VIEW

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Page.match(model.page, {
    Issues: page =>
      h.submodel({
        slotId: `issues-${model.pageId}`,
        model: page.model,
        view: Issues.view,
        toParentMessage: toGotIssuesMessage(model.pageId),
      }),
    Help: page =>
      h.submodel({
        slotId: `help-${model.pageId}`,
        model: page.model,
        view: Help.view,
        toParentMessage: toGotHelpMessage(model.pageId),
      }),
    Settings: page =>
      h.submodel({
        slotId: `settings-${model.pageId}`,
        model: page.model,
        view: Settings.view,
        toParentMessage: toGotSettingsMessage(model.pageId),
      }),
  })

const tabButton = (model: Model, tab: Tab, label: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.DataAttribute('testid', `tab-${tab}`), h.AriaPressed(String(tab === tabOf(model.page))), h.OnClick(Message.ClickedTab({ tab }))],
    [label],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Issue desk',
  body: h.div([], [
    h.nav([], [
      tabButton(
        model,
        'issues',
        Option.match(model.maybeOpenCount, { onNone: () => 'Issues', onSome: count => `Issues (${count})` }),
        h,
      ),
      tabButton(model, 'help', 'Help', h),
      tabButton(model, 'settings', 'Settings', h),
    ]),
    pageView(model, h),
  ]),
})
