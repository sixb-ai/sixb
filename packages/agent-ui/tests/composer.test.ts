import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer, type ComposerProps, composerCanFocus } from "../src/components/Composer"
import type { LanguageModel } from "../src/types"

const model = {
  provider: "gateway",
  modelId: "openai/gpt-5.4",
  isDefault: true,
  name: "GPT-5.4",
  publisher: {
    id: "openai",
    name: "OpenAI",
    logoUrl: "https://models.dev/logos/openai.svg",
  },
  via: "AI Gateway",
  capabilities: {
    input: ["text", "image", "pdf"],
    output: ["text"],
    reasoning: true,
    tools: true,
    contextWindowTokens: 1_050_000,
  },
  reasoningLevels: ["provider-default", "low", "medium", "high"],
} as const satisfies LanguageModel

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

  test("shows the selected model, provider logo, and reasoning control", () => {
    const html = renderComposer({
      models: [model],
      selectedModel: model,
      selectedReasoning: "medium",
      onSelectModel: () => undefined,
      onSelectReasoning: () => undefined,
    })

    expect(html).toContain("GPT-5.4")
    expect(html).toContain("https://models.dev/logos/openai.svg")
    expect(html).toContain("Medium")
    expect(html).toContain('aria-label="Choose model"')
  })

  test.each([false, true])("keeps send errors within the input width (compact: %s)", (compact) => {
    // Moving the error outside the composer's width constraint reproduces the misalignment.
    const nodes = elements(parseFragment(renderComposer({ compact, error: "Send failed." })))
    const alert = nodes.find((node) =>
      node.attrs.some((attribute) => attribute.name === "role" && attribute.value === "alert")
    )
    expect(alert).toBeDefined()
    const container = alert?.parentNode
    if (!container || !("attrs" in container)) throw new Error("Missing composer error container")
    expect(container.attrs.find((attribute) => attribute.name === "class")?.value).toContain(
      "max-w-2xl"
    )
    expect(elements(container).some((node) => node.tagName === "textarea")).toBe(true)
  })
})

function elements(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ]
}

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
