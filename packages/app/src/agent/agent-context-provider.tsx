import {
  type AgentContextInput,
  agentContextFingerprint,
  agentContextIdentity,
} from "@sixb/core/agents/context"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

type RegistrationToken = symbol

interface AgentContextRegistry {
  readonly context: readonly AgentContextInput[]
  readonly register: (token: RegistrationToken, context: AgentContextInput) => void
  readonly unregister: (token: RegistrationToken) => void
}

const RegistryContext = createContext<AgentContextRegistry | null>(null)

export function AgentContextProvider({ children }: { readonly children: ReactNode }) {
  const [registrations, setRegistrations] = useState(
    () => new Map<RegistrationToken, AgentContextInput>()
  )

  const register = useCallback((token: RegistrationToken, context: AgentContextInput) => {
    setRegistrations((current) => {
      const next = new Map(current)
      next.set(token, context)
      return next
    })
  }, [])

  const unregister = useCallback((token: RegistrationToken) => {
    setRegistrations((current) => {
      if (!current.has(token)) return current
      const next = new Map(current)
      next.delete(token)
      return next
    })
  }, [])

  const context = useMemo(() => {
    // Later registrations win while mounted. If they unmount, the previous value for that identity
    // naturally becomes active again; this makes nested page components compose without stale data.
    const byIdentity = new Map<string, AgentContextInput>()
    for (const value of registrations.values()) {
      byIdentity.set(agentContextIdentity(value), value)
    }
    return [...byIdentity.values()]
  }, [registrations])

  const value = useMemo(() => ({ context, register, unregister }), [context, register, unregister])
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>
}

/** Register ambient page context for every descendant AgentPanel that is not context-controlled. */
export function useAgentContext(context: AgentContextInput | null | undefined): void {
  const registry = useContext(RegistryContext)
  const tokenRef = useRef<RegistrationToken>(Symbol("agent-context"))
  const contextRef = useRef(context)
  contextRef.current = context
  const register = registry?.register
  const unregister = registry?.unregister
  const contextKey =
    context === null || context === undefined ? null : agentContextFingerprint(context)

  useEffect(() => {
    if (contextKey === null) return
    if (!register || !unregister) {
      throw new Error("[Sixb] useAgentContext() must be used inside AgentContextProvider.")
    }

    // Read through the ref so structurally identical inline helper values do not re-register after
    // every provider-driven render; contextKey remains the semantic effect dependency.
    const currentContext = contextRef.current
    if (!currentContext) return
    const token = tokenRef.current
    register(token, currentContext)
    return () => unregister(token)
  }, [contextKey, register, unregister])
}

export function useRegisteredAgentContext(): readonly AgentContextInput[] {
  return useContext(RegistryContext)?.context ?? []
}
