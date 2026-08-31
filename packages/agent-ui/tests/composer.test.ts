import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer, type ComposerProps, composerCanFocus } from "../src/components/Composer"

describe("Composer", () => {
  test("requests initial focus only while the input is available", () => {
    expect(renderComposer()).toContain('autofocus=""')
    expect(renderComposer({ disabled: true, running: true })).not.toContain('autofocus=""')
    expect(renderComposer({ pending: true })).not.toContain('autofocus=""')
  })

  test("uses one availability policy for initial, return, and completion focus", () => {
    expect(composerCanFocus({})).toBe(true)
    expect(composerCanFocus({ disabled: true })).toBe(false)
    expect(composerCanFocus({ pending: true })).toBe(false)
    expect(composerCanFocus({ running: true })).toBe(false)
  })
})

function renderComposer(props: Partial<ComposerProps> = {}): string {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Composer, {
        onSend: () => undefined,
        ...props,
      })
    )
  )
}
