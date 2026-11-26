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
    // One availability policy decides initial and return focus. An answer in flight is not in it:
    // the reader writes the next message meanwhile.
    expect(renderComposer()).toContain('autofocus=""')
    expect(renderComposer({ running: true })).toContain('autofocus=""')
    for (const unavailable of [{ disabled: true }, { pending: true }]) {
      expect(renderComposer(unavailable)).not.toContain('autofocus=""')
    }
  })

  test("names the selected model with its provider's logo, its thinking in the tooltip", () => {
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
    expect(html).toContain('aria-label="GPT-5.4, Medium. Change model and permissions"')
    expect(html).toContain('title="GPT-5.4 · Medium"')
  })

  test("shows the permissions in the same chip once the conversation can change them", () => {
    // Removal proof: drop the permissions from ComposerSettings; the mode is named nowhere.
    const html = renderComposer({ approvalMode: "accept-edits", onApprovalModeChange: () => {} })

    expect(html).toContain('data-approval-mode="accept-edits"')
    expect(html).toContain('aria-label="Allow edits. Change model and permissions"')
    expect(html).toContain(">Allow edits</span>")
    // Shift+Tab changes the mode from the empty message box; the chip claims no shortcut.
    expect(html).not.toContain("aria-keyshortcuts")
    // Beside a model, full access is the quiet default: the chip shows a mode's icon only when the
    // agent asks before something.
    const withModel = (approvalMode: "auto" | "manual") =>
      renderComposer({
        models: [model],
        selectedModel: model,
        onSelectModel: () => undefined,
        onSelectReasoning: () => undefined,
        approvalMode,
        onApprovalModeChange: () => {},
      })
    expect(withModel("manual")).toContain(
      'aria-label="GPT-5.4, Ask first. Change model and permissions"'
    )
    expect(withModel("manual")).toContain("lucide-hand")
    expect(withModel("auto")).not.toContain("lucide-zap")
    // Without a way to change it, as in a page that never wired it, there is no chip.
    expect(renderComposer({ approvalMode: "auto" })).not.toContain("data-approval-mode")
  })

  test("tells how to answer a turn that waits for the reader's approval", () => {
    expect(renderComposer({ awaitingApproval: true })).toContain(
      'placeholder="Approve above, or reply instead"'
    )
    expect(renderComposer({ placeholder: "Ask about invoices" })).toContain(
      'placeholder="Ask about invoices"'
    )
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
      "max-w-[46rem]"
    )
    expect(elements(container).some((node) => node.tagName === "textarea")).toBe(true)
  })

  test("collapses the settings chip to its icon in a narrow composer so actions stay on one row", () => {
    // Removal proof: drop `@container/composer` from Composer or `@max-md/composer:hidden` /
    // AutoMark from ComposerSettings; the label stays visible on narrow screens or Auto loses its
    // mark.
    const pinned = renderComposer({
      models: [model],
      selectedModel: model,
      onSelectModel: () => undefined,
      onSelectReasoning: () => undefined,
    })
    expect(pinned).toContain("@container/composer")
    const pinnedButton = settingsButton(pinned)
    expect(classOf(pinnedButton)).toContain("@max-md/composer:px-2")
    expect(classOf(findSpanWithText(pinnedButton, "GPT-5.4"))).toContain("@max-md/composer:hidden")

    const auto = renderComposer({
      models: [{ ...model, tier: "standard" }],
      onSelectModel: () => undefined,
      onSelectReasoning: () => undefined,
      onResetModelSelection: () => undefined,
    })
    const autoButton = settingsButton(auto)
    expect(classOf(findSpanWithText(autoButton, "Auto"))).toContain("@max-md/composer:hidden")
    expect(
      elements(autoButton).some(
        (node) => node.tagName === "svg" && classOf(node).includes("@max-md/composer:block")
      )
    ).toBe(true)

    // Without an icon to fall back to, keep the error label visible rather than an empty chevron.
    const unavailable = renderComposer({
      models: [],
      modelsError: true,
      onSelectModel: () => undefined,
      onSelectReasoning: () => undefined,
    })
    expect(
      classOf(findSpanWithText(settingsButton(unavailable), "Models unavailable"))
    ).not.toContain("@max-md/composer:hidden")
  })
})

function classOf(node: DefaultTreeAdapterTypes.Element | undefined): string {
  return node?.attrs.find((attribute) => attribute.name === "class")?.value ?? ""
}

function settingsButton(html: string): DefaultTreeAdapterTypes.Element {
  const button = elements(parseFragment(html)).find(
    (node) => node.tagName === "button" && classOf(node).includes("group/settings")
  )
  if (!button) throw new Error("Missing settings button")
  return button
}

function findSpanWithText(
  root: DefaultTreeAdapterTypes.Element,
  text: string
): DefaultTreeAdapterTypes.Element | undefined {
  return elements(root).find(
    (node) =>
      node.tagName === "span" &&
      node.childNodes.some((child) => "value" in child && child.value === text)
  )
}

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
