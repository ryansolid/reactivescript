import { Option, Schema } from 'effect'
import { Command, type Runtime, Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Archive from './archive'
import * as Board from './board'

// MODEL

const Tab = Schema.Literals(['board', 'archive'])
type Tab = typeof Tab.Type

// Only the open page is kept: leaving a page discards it. Each opening of a page gets a new `pageId`, and answers to
// a page that was left carry an old one, so they reach nothing.
export const Page = defineTaggedUnion({
  Board: { model: Board.Model },
  Archive: { model: Archive.Model },
})
type Page = typeof Page.Type

export const Model = Schema.Struct({ pageId: Schema.Number, page: Page })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedTab: { tab: Tab },
  GotBoardMessage: { pageId: Schema.Number, message: Board.Message },
  GotArchiveMessage: { pageId: Schema.Number, message: Archive.Message },
})
export type Message = typeof Message.Type

// INIT

type UpdateReturn = Update.Return<Model, Message>

const toGotBoardMessage = (pageId: number) => (message: Board.Message) => Message.GotBoardMessage({ pageId, message })
const toGotArchiveMessage = (pageId: number) => (message: Archive.Message) =>
  Message.GotArchiveMessage({ pageId, message })

const openBoard = (model: Model): UpdateReturn => {
  const pageId = model.pageId + 1
  const boardInit = Board.init()
  return {
    model: modifyFields(model, { pageId: () => pageId, page: () => Page.Board({ model: boardInit.model }) }),
    commands: Command.mapMessages(boardInit.commands, toGotBoardMessage(pageId)),
  }
}

const openArchive = (model: Model): UpdateReturn => {
  const pageId = model.pageId + 1
  const archiveInit = Archive.init()
  return {
    model: modifyFields(model, { pageId: () => pageId, page: () => Page.Archive({ model: archiveInit.model }) }),
    commands: Command.mapMessages(archiveInit.commands, toGotArchiveMessage(pageId)),
  }
}

export const init: Runtime.ApplicationInit<Model, Message> = () =>
  openBoard({ pageId: 0, page: Page.Archive({ model: Archive.init().model }) })

// UPDATE

const tabOf = (page: Page): Tab => Page.match<Tab>(page, { Board: () => 'board', Archive: () => 'archive' })

const foldBoardMessage = (pageId: number) =>
  Update.foldChild({
    update: Board.update,
    read: (model: Model) =>
      model.page._tag === 'Board' && pageId === model.pageId ? Option.some(model.page.model) : Option.none(),
    write: (model, nextBoard) => modifyFields(model, { page: () => Page.Board({ model: nextBoard }) }),
    toParentMessage: toGotBoardMessage(pageId),
  })

const foldArchiveMessage = (pageId: number) =>
  Update.foldChild({
    update: Archive.update,
    read: (model: Model) =>
      model.page._tag === 'Archive' && pageId === model.pageId ? Option.some(model.page.model) : Option.none(),
    write: (model, nextArchive) => modifyFields(model, { page: () => Page.Archive({ model: nextArchive }) }),
    toParentMessage: toGotArchiveMessage(pageId),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedTab: ({ tab }) => {
      if (tab === tabOf(model.page)) {
        return { model }
      }
      return tab === 'board' ? openBoard(model) : openArchive(model)
    },

    GotBoardMessage: ({ pageId, message }) => foldBoardMessage(pageId)(model, message),

    GotArchiveMessage: ({ pageId, message }) => foldArchiveMessage(pageId)(model, message),
  })

// VIEW

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Page.match(model.page, {
    Board: page =>
      h.submodel({
        slotId: `board-${model.pageId}`,
        model: page.model,
        view: Board.view,
        toParentMessage: toGotBoardMessage(model.pageId),
      }),
    Archive: page =>
      h.submodel({
        slotId: `archive-${model.pageId}`,
        model: page.model,
        view: Archive.view,
        toParentMessage: toGotArchiveMessage(model.pageId),
      }),
  })

const tabButton = (model: Model, tab: Tab, label: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.DataAttribute('testid', `tab-${tab}`),
      h.AriaPressed(String(tab === tabOf(model.page))),
      h.OnClick(Message.ClickedTab({ tab })),
    ],
    [label],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Sprint board',
  body: h.div([], [
    h.nav([], [tabButton(model, 'board', 'Board', h), ' ', tabButton(model, 'archive', 'Archive', h)]),
    pageView(model, h),
  ]),
})
