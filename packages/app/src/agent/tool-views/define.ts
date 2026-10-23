import type { AgentToolDefinition, InferAgentToolInput, InferAgentToolOutput } from "@sixb/core"
import type { ReactNode } from "react"

/** Where a tool's view shows in the chat: in place of its row in the work, or in the answer. */
export type AgentToolViewPlacement = "work" | "answer"

/**
 * What a tool's view receives, by the state of the call. A saved message holds only finished
 * calls; a live reply goes through every state.
 */
export type AgentToolViewProps<TTool extends AgentToolDefinition = AgentToolDefinition> =
  | {
      /** The model is still writing the input. */
      readonly state: "input-streaming"
      /** The input written so far: partial JSON text. */
      readonly inputText?: string
      readonly input?: undefined
      readonly output?: undefined
      readonly errorText?: undefined
    }
  | {
      /** The input is valid and the tool is running. */
      readonly state: "input-available"
      readonly inputText?: undefined
      readonly input: InferAgentToolInput<TTool>
      readonly output?: undefined
      readonly errorText?: undefined
    }
  | {
      readonly state: "output-available"
      readonly inputText?: undefined
      readonly input: InferAgentToolInput<TTool>
      readonly output: InferAgentToolOutput<TTool>
      readonly errorText?: undefined
    }
  | {
      readonly state: "output-error"
      readonly inputText?: undefined
      /**
       * What the model sent, when the call got that far. Not typed as the tool's input: a call
       * refused for its input carries the input it was refused for, which may not match the schema.
       */
      readonly input?: unknown
      readonly output?: undefined
      readonly errorText: string
    }

// Views are stored together whatever their tool. Keep variance erasure at this boundary, so a
// list of views for different tools is a `readonly AgentToolView[]`.
type StoredAgentToolViewRender<TTool extends AgentToolDefinition> = {
  bivarianceHack(props: AgentToolViewProps<TTool>): ReactNode
}["bivarianceHack"]

/** How the chat shows one tool's calls. Register it in the `toolViews` export of `app/layout.tsx`. */
export interface AgentToolView<TTool extends AgentToolDefinition = AgentToolDefinition> {
  readonly kind: "agentToolView"
  readonly toolName: TTool["name"]
  readonly placement: AgentToolViewPlacement
  readonly render: StoredAgentToolViewRender<TTool>
}

const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const PLACEMENTS: readonly AgentToolViewPlacement[] = ["work", "answer"]

/**
 * Define how the chat shows a tool's calls. Type it with the tool's definition, imported as a type
 * so nothing from the server reaches the browser:
 *
 * ```tsx
 * import type { quoteShipping } from "../../agent-tools/quote-shipping"
 *
 * export const quoteView = defineAgentToolView<typeof quoteShipping>("quote_shipping", {
 *   placement: "answer",
 * }).render(({ state, output }) => (state === "output-available" ? <Quote {...output} /> : null))
 * ```
 *
 * The component renders as a React component, so it can use hooks. A view that throws falls back
 * to the tool's built-in row.
 */
export function defineAgentToolView<TTool extends AgentToolDefinition>(
  name: TTool["name"],
  options: { readonly placement?: AgentToolViewPlacement } = {}
): {
  render(component: (props: AgentToolViewProps<TTool>) => ReactNode): AgentToolView<TTool>
} {
  if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `[SixbApp] defineAgentToolView needs the name of a tool: 1-64 characters, starting with a letter or underscore, with only letters, numbers, underscores, or hyphens. Got ${JSON.stringify(name)}.`
    )
  }

  const placement = options.placement ?? "work"
  if (!PLACEMENTS.includes(placement)) {
    throw new Error(
      `[SixbApp] The view of tool '${name}' has placement ${JSON.stringify(placement)}. Use "work" or "answer".`
    )
  }

  return {
    render(component) {
      if (typeof component !== "function") {
        throw new Error(
          `[SixbApp] The view of tool '${name}' needs a component: pass one to .render().`
        )
      }

      return Object.freeze({ kind: "agentToolView", toolName: name, placement, render: component })
    },
  }
}

export function isAgentToolView(value: unknown): value is AgentToolView {
  if (typeof value !== "object" || value === null) return false

  return (
    Reflect.get(value, "kind") === "agentToolView" &&
    typeof Reflect.get(value, "toolName") === "string" &&
    (PLACEMENTS as readonly unknown[]).includes(Reflect.get(value, "placement")) &&
    typeof Reflect.get(value, "render") === "function"
  )
}

/**
 * The views of a layout's `toolViews` export by tool name. Both the build, when it loads the
 * layout, and the provider in the browser read the export through this, so a mistake is reported
 * the same way: `fail` turns what is wrong into the error to throw.
 */
export function agentToolViews(
  views: unknown,
  fail: (detail: string) => Error = (detail) =>
    new Error(`[SixbApp] Invalid toolViews in app/layout.tsx: ${detail}`)
): ReadonlyMap<string, AgentToolView> {
  if (views === undefined) return new Map()
  if (!Array.isArray(views)) {
    throw fail("the named toolViews export must be an array of views from defineAgentToolView.")
  }

  const registry = new Map<string, AgentToolView>()
  views.forEach((view: unknown, index) => {
    if (!isAgentToolView(view)) {
      throw fail(`toolViews[${index}] is not a view from defineAgentToolView.`)
    }
    if (registry.has(view.toolName)) {
      throw fail(`two views for the tool '${view.toolName}'. Keep one view per tool.`)
    }
    registry.set(view.toolName, view)
  })

  return registry
}
