import type { AgentToolDefinition, InferAgentToolInput, InferAgentToolOutput } from "@sixb/core"
import { Component, createContext, type ReactNode, useContext, useMemo } from "react"
import type { NormalizedPart, NormalizedTool } from "../parts"
import { type AgentToolView, type AgentToolViewProps, agentToolViews } from "./define"

type AgentToolViews = ReadonlyMap<string, AgentToolView>

const AgentToolViewsContext = createContext<AgentToolViews>(new Map())

/**
 * Carries the project's `toolViews`, exported by `app/layout.tsx`, to every chat in the app. The
 * generated app mounts it around the layout; without it, chats show the framework's views alone.
 */
export function AgentToolViewsProvider({
  views,
  children,
}: {
  readonly views: unknown
  readonly children: ReactNode
}) {
  const registry = useMemo(() => agentToolViews(views), [views])

  return (
    <AgentToolViewsContext.Provider value={registry}>{children}</AgentToolViewsContext.Provider>
  )
}

/** The project's view of a tool, which takes the place of the framework's. */
export function useAgentToolView(toolName: string): AgentToolView | undefined {
  return useContext(AgentToolViewsContext).get(toolName)
}

/**
 * The views of the turn's tools shown in the answer, in call order. Each call keeps its row in the
 * work; a view that fails shows nothing here.
 */
export function AnswerToolViews({ parts }: { readonly parts: readonly NormalizedPart[] }) {
  const views = useContext(AgentToolViewsContext)

  return parts.map((part, index) => {
    if (part.kind !== "tool") return null
    const view = views.get(part.tool.toolName)
    if (view?.placement !== "answer") return null

    return <ProjectToolView key={`answer-${index}`} view={view} tool={part.tool} fallback={null} />
  })
}

/** A call shown through the project's view, or through `fallback` when the view throws. */
export function ProjectToolView({
  view,
  tool,
  fallback,
}: {
  readonly view: AgentToolView
  readonly tool: NormalizedTool
  readonly fallback: ReactNode
}) {
  const View = view.render

  return (
    <ToolViewBoundary toolName={view.toolName} state={tool.state} fallback={fallback}>
      <View {...toolViewProps(tool)} />
    </ToolViewBoundary>
  )
}

type Input = InferAgentToolInput<AgentToolDefinition>
type Output = InferAgentToolOutput<AgentToolDefinition>

// The browser has the tool's types, not its schema: the view takes what the server saved or
// streamed for the call as the tool's input and output.
function toolViewProps(tool: NormalizedTool): AgentToolViewProps {
  switch (tool.state) {
    case "input-streaming":
      return tool.inputText === undefined
        ? { state: tool.state }
        : { state: tool.state, inputText: tool.inputText }
    case "input-available":
      return { state: tool.state, input: tool.input as Input }
    case "output-available":
      return { state: tool.state, input: tool.input as Input, output: tool.output as Output }
    case "output-error":
      return {
        state: tool.state,
        ...(tool.input === undefined ? {} : { input: tool.input }),
        errorText: tool.errorText ?? "",
      }
  }
}

/**
 * Keeps a failing view from taking the chat down. A call that moves on to its next state tries
 * the view again, so a view that cannot read a partial input still shows the finished call.
 */
class ToolViewBoundary extends Component<
  {
    readonly toolName: string
    readonly state: NormalizedTool["state"]
    readonly fallback: ReactNode
    readonly children: ReactNode
  },
  { readonly failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(
      `[SixbApp] The view of tool '${this.props.toolName}' failed to render; the chat shows the tool's built-in row instead.`,
      error
    )
  }

  componentDidUpdate(previous: { readonly state: NormalizedTool["state"] }) {
    if (this.state.failed && previous.state !== this.props.state) this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
