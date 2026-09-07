import type { AgentToolInputSchema, InferAgentToolInputSchema } from "@sixb/core"
import {
  type AgentContextInput,
  agentContextIdentity,
  compileAgentContextCommandInput,
  normalizeAgentContextEntries,
} from "@sixb/core/agents/context"

export interface AgentContextCommand<TInput extends AgentToolInputSchema = AgentToolInputSchema> {
  readonly description: string
  readonly input: TInput
  /** Update the current view. Business changes belong to Sixb actions and workflows. */
  readonly run: (
    input: InferAgentToolInputSchema<TInput>,
    context: { readonly signal: AbortSignal }
  ) => void | Promise<void>
}

export interface AgentContextOptions<
  TCommands extends Readonly<Record<string, AgentToolInputSchema>> = Readonly<
    Record<string, AgentToolInputSchema>
  >,
> {
  readonly commands: {
    readonly [K in keyof TCommands]: AgentContextCommand<TCommands[K]>
  }
}

interface CommandDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface RegisteredContextCommands {
  readonly descriptors: readonly CommandDescriptor[]
  readonly invoke: (name: string, input: unknown, signal: AbortSignal) => Promise<void>
}

export interface AgentContextInspection {
  readonly registrationId: string
  readonly identity: string
  readonly context: AgentContextInput
  readonly commands: readonly CommandDescriptor[]
}

interface Registration {
  readonly id: string
  readonly context: AgentContextInput
  readonly commands?: RegisteredContextCommands
  readonly pending: Set<AbortController>
}

/** Live component bindings. Only context snapshots, never callbacks, leave the browser. */
export class AgentContextRegistry {
  readonly #registrations = new Map<symbol, Registration>()
  readonly #listeners = new Set<() => void>()
  #context: readonly AgentContextInput[] = []

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getContext = () => this.#context

  register(token: symbol, context: AgentContextInput, commands?: RegisteredContextCommands): void {
    const snapshot = normalizeAgentContextEntries([{ context, origin: "ambient" }])[0]?.context
    if (!snapshot) throw new Error("[Sixb] Agent context is missing.")
    const previous = this.#registrations.get(token)
    const sameIdentity =
      previous && agentContextIdentity(previous.context) === agentContextIdentity(snapshot)
    if (previous && !sameIdentity) this.#abort(previous)
    this.#registrations.set(token, {
      id: sameIdentity ? previous.id : crypto.randomUUID(),
      context: snapshot,
      commands,
      pending: sameIdentity ? previous.pending : new Set(),
    })
    this.#changed()
  }

  unregister(token: symbol): void {
    const registration = this.#registrations.get(token)
    if (!registration) return
    this.#abort(registration)
    this.#registrations.delete(token)
    this.#changed()
  }

  inspect(excluded: readonly string[] = []): readonly AgentContextInspection[] {
    return this.#active()
      .filter((entry) => !excluded.includes(agentContextIdentity(entry.context)))
      .map((entry) => ({
        registrationId: entry.id,
        identity: agentContextIdentity(entry.context),
        context:
          entry.context.kind === "app-state"
            ? {
                kind: "app-state",
                id: entry.context.id,
                label: entry.context.label,
                description: entry.context.description,
                value:
                  entry.context.modelValue === undefined
                    ? entry.context.value
                    : entry.context.modelValue,
              }
            : entry.context,
        commands: entry.commands?.descriptors ?? [],
      }))
  }

  async invoke(input: {
    readonly registrationId: string
    readonly command: string
    readonly input: unknown
    readonly excluded: readonly string[]
    readonly signal: AbortSignal
  }): Promise<void> {
    input.signal.throwIfAborted()
    const entry = this.#active().find((candidate) => candidate.id === input.registrationId)
    if (!entry?.commands || input.excluded.includes(agentContextIdentity(entry.context))) {
      throw new Error(
        "[Sixb] That view is no longer available. Inspect the current app and try again."
      )
    }
    const controller = new AbortController()
    const abort = () => controller.abort(input.signal.reason)
    input.signal.addEventListener("abort", abort, { once: true })
    entry.pending.add(controller)
    let onAbort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      await Promise.race([
        entry.commands.invoke(input.command, input.input, controller.signal),
        cancelled,
      ])
      controller.signal.throwIfAborted()
    } finally {
      entry.pending.delete(controller)
      input.signal.removeEventListener("abort", abort)
      if (onAbort) controller.signal.removeEventListener("abort", onAbort)
    }
  }

  #active(): Registration[] {
    const active = new Map<string, Registration>()
    for (const entry of this.#registrations.values()) {
      active.set(agentContextIdentity(entry.context), entry)
    }
    return [...active.values()]
  }

  #abort(entry: Registration): void {
    for (const controller of entry.pending) {
      controller.abort(new Error("[Sixb] The view was unmounted or replaced."))
    }
  }

  #changed(): void {
    const active = this.#active()
    for (const entry of this.#registrations.values()) {
      if (!active.includes(entry)) this.#abort(entry)
    }
    this.#context = active.map((entry) => entry.context)
    for (const listener of this.#listeners) listener()
  }
}

/** Compile serializable descriptors, but always call the latest committed React handler. */
export function registerContextCommands<
  const TCommands extends Readonly<Record<string, AgentToolInputSchema>>,
>(
  options: AgentContextOptions<TCommands>,
  current: () => AgentContextOptions<TCommands> | undefined
): RegisteredContextCommands {
  const schemas = new Map<string, ReturnType<typeof compileAgentContextCommandInput>>()
  const descriptors = Object.entries(options.commands).map(([name, command]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) || !command.description.trim()) {
      throw new Error("[Sixb] View commands need a valid name and a non-empty description.")
    }
    const schema = compileAgentContextCommandInput(name, command.input)
    schemas.set(name, schema)
    return {
      name,
      description: command.description,
      inputSchema: schema.inputSchema,
    }
  })
  return {
    descriptors,
    async invoke(name, input, signal) {
      const schema = schemas.get(name)
      const commands = current()?.commands
      if (!schema || !commands || !Object.hasOwn(commands, name)) {
        throw new Error(`[Sixb] View command '${name}' is no longer available.`)
      }
      const command = commands[name]
      if (!command) throw new Error(`[Sixb] View command '${name}' is no longer available.`)
      const validated = schema.parse(input)
      signal.throwIfAborted()
      // The same Sixb schema supplies inference and runtime normalization at this boundary.
      await command.run(validated as InferAgentToolInputSchema<TCommands[string]>, { signal })
    },
  }
}
