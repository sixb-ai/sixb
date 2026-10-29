import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render } from "@testing-library/react"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import {
  builtInCommands,
  commandQuery,
  matchCommands,
} from "../src/agent/components/composer-commands"
import { en } from "../src/agent/i18n/en"
import type { LanguageModel } from "../src/agent/types"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

function model(modelId: string, name: string, tier?: LanguageModel["tier"]): LanguageModel {
  return {
    provider: "gateway",
    modelId,
    name,
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault: tier === "standard",
    capabilities: { input: ["text"], output: ["text"] },
    reasoningLevels: ["provider-default"],
    ...(tier ? { tier } : {}),
  }
}

const sonnet = model("anthropic/sonnet", "Claude Sonnet 5.5", "standard")
const opus = model("anthropic/opus", "Claude Opus 5.5", "heavy")

describe("slash commands", () => {
  test("a command is the whole message: one slash word", () => {
    expect(commandQuery("/")).toBe("")
    expect(commandQuery("/Opus")).toBe("opus")
    expect(commandQuery("/opus now")).toBeNull()
    expect(commandQuery("ask /opus")).toBeNull()
    expect(commandQuery("/a/b")).toBeNull()
  })

  test("names that start with the query come first, then names and labels that contain it", () => {
    const commands = builtInCommands({
      models: [sonnet, opus],
      onSelectModel: () => {},
      onResetModelSelection: () => {},
      onApprovalModeChange: () => {},
      messages: en.commands,
    })
    expect(commands.map((command) => command.name)).toEqual([
      "auto",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "ask",
      "edits",
      "full",
    ])
    expect(matchCommands(commands, "a").map((command) => command.name)).toEqual([
      "auto",
      "ask",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "edits",
      "full",
    ])
    expect(matchCommands(commands, "opus").map((command) => command.name)).toEqual([
      "claude-opus-5-5",
    ])
  })

  test("only what the composer can change has a command", () => {
    // Without tiers there is no Auto to go back to; without handlers, no model or mode commands.
    const list = builtInCommands({
      models: [{ ...sonnet, tier: undefined }],
      onSelectModel: () => {},
      onResetModelSelection: () => {},
      messages: en.commands,
    })
    expect(list.map((command) => command.name)).toEqual(["claude-sonnet-5-5"])
    expect(builtInCommands({ models: [sonnet], messages: en.commands })).toEqual([])
  })

  // Removal proof: drop the commands branch from the composer's handleKeyDown; Enter sends "/full"
  // as a message and the mode stays.
  test("Enter runs the highlighted command instead of sending, and clears the message", () => {
    const modes: string[] = []
    const sent: string[] = []
    const view = renderComposer({
      onSend: (text) => sent.push(text),
      approvalMode: "manual",
      onApprovalModeChange: (mode) => modes.push(mode),
    })

    type(view.input(), "/full")
    expect(view.getByRole("option", { name: /Run everything without asking/ })).toBeDefined()
    fireEvent.keyDown(view.input(), { key: "Enter" })

    expect(modes).toEqual(["auto"])
    expect(sent).toEqual([])
    expect(view.input().value).toBe("")
    expect(view.queryByRole("listbox", { name: "Commands" })).toBeNull()
  })

  // Removal proof: drop `dismissedCommand` from the composer; Escape leaves the list open and
  // Enter runs the command.
  test("Escape closes the list, and the text is sent as typed", () => {
    const modes: string[] = []
    const sent: string[] = []
    const view = renderComposer({
      onSend: (text) => sent.push(text),
      approvalMode: "manual",
      onApprovalModeChange: (mode) => modes.push(mode),
    })

    type(view.input(), "/full")
    fireEvent.keyDown(view.input(), { key: "Escape" })
    expect(view.queryByRole("listbox", { name: "Commands" })).toBeNull()
    fireEvent.keyDown(view.input(), { key: "Enter" })

    expect(sent).toEqual(["/full"])
    expect(modes).toEqual([])
  })

  test("a page's own commands follow the built-in ones", () => {
    const ran: string[] = []
    const view = renderComposer({
      commands: [{ name: "summary", label: "Summarize this page", run: () => ran.push("summary") }],
    })

    type(view.input(), "/sum")
    fireEvent.click(view.getByRole("option", { name: /Summarize this page/ }))

    expect(ran).toEqual(["summary"])
    expect(view.input().value).toBe("")
  })
})

describe("the composer's layout", () => {
  // Removal proof: drop `value.includes("\n")` from `expanded`; a two-line draft stays in the row.
  test("a draft on more than one line gets a row of its own, above the controls", () => {
    const view = renderComposer({})
    const surface = () => view.input().closest(".sixb-composer-surface")

    type(view.input(), "Flag every late order")
    expect(surface()?.hasAttribute("data-expanded")).toBe(false)
    type(view.input(), "Flag every late order\nand draft a note")
    expect(surface()?.hasAttribute("data-expanded")).toBe(true)
  })
})

function renderComposer(props: Partial<ComposerProps>) {
  const queryClient = new QueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Composer onSend={() => {}} {...props} />
    </QueryClientProvider>
  )
  const input = () => view.getByLabelText("Message") as HTMLTextAreaElement
  return { ...view, input }
}

/**
 * React DOM was imported before Happy DOM, so it sees typing through its fallback: a keyup in the
 * field that has focus.
 */
function type(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) })
}
