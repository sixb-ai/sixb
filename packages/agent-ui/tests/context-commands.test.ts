import { describe, expect, test } from "bun:test"
import { stringEnum } from "@sixb/core"
import { agentContext } from "@sixb/core/agents/context"
import { AgentContextRegistry, registerContextCommands } from "../src/context-commands"

const view = (mode = "timeline") =>
  agentContext.appState("dispatch", {
    label: "Dispatch",
    description: "Current schedule",
    value: { mode },
  })

function fixture() {
  const registry = new AgentContextRegistry()
  const token = Symbol("dispatch")
  const calls: string[] = []
  const options = {
    commands: {
      setView: {
        description: "Set the schedule view",
        input: { view: stringEnum(["timeline", "list"]) },
        run: (input: { readonly view: "timeline" | "list" }) => {
          calls.push(input.view)
        },
      },
    },
  }
  const commands = registerContextCommands(options, () => options)
  registry.register(token, view(), commands)
  const registrationId = registry.inspect()[0]!.registrationId
  const invoke = (input: unknown, excluded: readonly string[] = []) =>
    registry.invoke({
      registrationId,
      command: "setView",
      input,
      excluded,
      signal: new AbortController().signal,
    })
  return { registry, token, calls, commands, registrationId, invoke }
}

describe("live context commands", () => {
  test("uses Sixb schemas to validate inputs before running a view operation", async () => {
    const { registry, invoke, calls } = fixture()
    expect(registry.inspect()[0]?.commands[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { view: { enum: ["timeline", "list"] } },
      required: ["view"],
      additionalProperties: false,
    })
    await expect(invoke({ view: "grid" })).rejects.toThrow("must be one of")
    await expect(invoke({ view: "list", unexpected: true })).rejects.toThrow()
    expect(calls).toEqual([])
    await invoke({ view: "list" })
    expect(calls).toEqual(["list"])
  })

  test("keeps persisted context as data and only inspects its model-safe projection", () => {
    const { registry, token, commands } = fixture()
    const context = agentContext.appState("dispatch", {
      label: "Dispatch",
      description: "Current view",
      value: { secret: "host-only" },
      modelValue: null,
    })
    registry.register(token, context, commands)
    expect(registry.getContext()).toEqual([context])
    expect(JSON.stringify(registry.getContext())).not.toContain("setView")
    expect(JSON.stringify(registry.inspect())).not.toContain("host-only")
    expect(registry.inspect()[0]?.context).toMatchObject({ value: null })
  })

  test("updates state without replacing the component's binding", async () => {
    const { registry, token, commands, registrationId, invoke } = fixture()
    registry.register(token, view("list"), commands)
    expect(registry.inspect()[0]).toMatchObject({
      registrationId,
      context: { value: { mode: "list" } },
    })
    await invoke({ view: "timeline" })
  })

  test("a removed composer context cannot be inspected or invoked", async () => {
    const { registry, invoke, calls } = fixture()
    expect(registry.inspect(["app-state:dispatch"])).toEqual([])
    // Guard check: remove the excluded identity check in AgentContextRegistry.invoke.
    await expect(invoke({ view: "list" }, ["app-state:dispatch"])).rejects.toThrow(
      "no longer available"
    )
    expect(calls).toEqual([])
  })

  test("unmount/remount cannot resurrect an old command binding", async () => {
    const { registry, token, commands, registrationId, invoke, calls } = fixture()
    registry.unregister(token)
    registry.register(Symbol("new dispatch"), view(), commands)
    expect(registry.inspect()[0]?.registrationId).not.toBe(registrationId)
    await expect(invoke({ view: "list" })).rejects.toThrow("no longer available")
    expect(calls).toEqual([])
  })

  test("nested context overrides shadow commands and restore the parent on unmount", async () => {
    const { registry, commands, invoke, calls } = fixture()
    const nested = Symbol("nested")
    registry.register(nested, view("list"), commands)
    await expect(invoke({ view: "list" })).rejects.toThrow("no longer available")
    registry.unregister(nested)
    await invoke({ view: "list" })
    expect(calls).toEqual(["list"])
  })

  test("changing the subject invalidates the old binding even when the component stays mounted", async () => {
    const { registry, token, commands, invoke } = fixture()
    registry.register(token, agentContext.object({ id: "ServiceCase" }, "SC-1042"), commands)
    await expect(invoke({ view: "list" })).rejects.toThrow("no longer available")
  })

  test("unknown commands cannot reach inherited object properties", async () => {
    const { registry, registrationId } = fixture()
    await expect(
      registry.invoke({
        registrationId,
        command: "toString",
        input: {},
        excluded: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("no longer available")
  })

  test("unmount cancels an in-flight handler and releases the bridge even if it ignores cancellation", async () => {
    const registry = new AgentContextRegistry()
    const token = Symbol("view")
    let handlerSignal: AbortSignal | undefined
    const options = {
      commands: {
        pending: {
          description: "Wait for the view",
          input: {},
          run: (_input: object, { signal }: { signal: AbortSignal }) => {
            handlerSignal = signal
            return new Promise<void>(() => {})
          },
        },
      },
    }
    registry.register(
      token,
      view(),
      registerContextCommands(options, () => options)
    )
    const pending = registry.invoke({
      registrationId: registry.inspect()[0]!.registrationId,
      command: "pending",
      input: {},
      excluded: [],
      signal: new AbortController().signal,
    })
    registry.unregister(token)
    await expect(pending).rejects.toThrow("unmounted")
    expect(handlerSignal?.aborted).toBe(true)
  })
})
