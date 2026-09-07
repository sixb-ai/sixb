import type { AgentToolInputSchema } from "@sixb/core"
import { type AgentContextInput, agentContextFingerprint } from "@sixb/core/agents/context"
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  type AgentContextOptions,
  AgentContextRegistry,
  registerContextCommands,
} from "./context-commands"

const RegistryContext = createContext<AgentContextRegistry | null>(null)
const emptyContext: readonly AgentContextInput[] = []
const emptySnapshot = () => emptyContext
const emptySubscribe = () => () => {}

export function AgentContextProvider({ children }: { readonly children: ReactNode }) {
  const [registry] = useState(() => new AgentContextRegistry())
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
}

/** Register ambient context and optional live view commands for this component's lifetime. */
export function useAgentContext<
  const TCommands extends Readonly<Record<string, AgentToolInputSchema>>,
>(context: AgentContextInput | null | undefined, options?: AgentContextOptions<TCommands>): void {
  const registry = useContext(RegistryContext)
  const tokenRef = useRef(Symbol("agent-context"))
  const optionsRef = useRef(options)
  const contextRef = useRef(context)
  useLayoutEffect(() => {
    optionsRef.current = options
    contextRef.current = context
  })
  const contextKey = context == null ? null : agentContextFingerprint(context)
  // Handler identity is deliberately excluded: inline callbacks read committed props through refs.
  const commandsKey = JSON.stringify(
    Object.entries(options?.commands ?? {}).map(([name, command]) => ({
      name,
      description: command.description,
      input: command.input,
    }))
  )
  useLayoutEffect(() => {
    if (contextKey !== null && !registry) {
      throw new Error("[Sixb] useAgentContext() must be used inside AgentContextProvider.")
    }
    if (!registry) return
    const commands =
      optionsRef.current && commandsKey !== "[]"
        ? registerContextCommands(optionsRef.current, () => optionsRef.current)
        : undefined
    if (contextRef.current == null) registry.unregister(tokenRef.current)
    else registry.register(tokenRef.current, contextRef.current, commands)
  }, [registry, contextKey, commandsKey])

  useLayoutEffect(() => {
    const token = tokenRef.current
    return () => registry?.unregister(token)
  }, [registry])
}

export function useRegisteredAgentContext(): readonly AgentContextInput[] {
  const registry = useContext(RegistryContext)
  return useSyncExternalStore(
    registry?.subscribe ?? emptySubscribe,
    registry?.getContext ?? emptySnapshot,
    emptySnapshot
  )
}

/** Host integration for the tab-local browser command bridge. */
export function useAgentContextRegistry(): AgentContextRegistry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error("[Sixb] The app bridge requires AgentContextProvider.")
  return registry
}
