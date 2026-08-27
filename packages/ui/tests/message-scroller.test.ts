import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../src/components/ui/message-scroller"

describe("message scroller", () => {
  test("keeps viewport geometry stable while autoscrolling", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageScrollerProvider,
        { autoScroll: true },
        createElement(
          MessageScroller,
          null,
          createElement(
            MessageScrollerViewport,
            null,
            createElement(
              MessageScrollerContent,
              null,
              createElement(MessageScrollerItem, { messageId: "long-message" }, "Content")
            )
          )
        )
      )
    )

    expect(html).toContain("scrollbar-gutter-stable")
    expect(html).not.toContain("scrollbar-none")
  })
})
