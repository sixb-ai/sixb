import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import type { LanguageModel } from "../src/agent/types"

const model = {
  provider: "gateway",
  modelId: "openai/gpt-5.4",
  isDefault: true,
  name: "GPT-5.4",
  publisher: {
    id: "openai",
    name: "OpenAI",
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
    // One availability policy decides initial, return, and completion focus.
    expect(renderComposer()).toContain('autofocus=""')
    for (const unavailable of [{ disabled: true }, { pending: true }, { running: true }]) {
      expect(renderComposer(unavailable)).not.toContain('autofocus=""')
    }
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
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).not.toContain("models.dev")
    expect(html).toContain("Medium")
    expect(html).toContain('aria-label="Choose model and reasoning effort"')
  })

  test("keeps send errors within the input width", () => {
    // Moving the error outside the composer's width constraint reproduces the misalignment.
    const nodes = elements(parseFragment(renderComposer({ error: "Send failed." })))
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
