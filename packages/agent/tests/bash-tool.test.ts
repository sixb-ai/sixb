import { describe, expect, test } from "bun:test"
import type { CommandResult, RunCommandOptions, Sandbox } from "@sixb/core"
import { BackgroundCommands } from "../src/background-commands"
import {
  BASH_TOOL_SPEC,
  type BashToolOutput,
  compressStdout,
  createBashTool,
} from "../src/tools/bash"

const CAP = 200

describe("compressStdout", () => {
  test("leaves output that fits untouched and compacts JSON that fits once whitespace is dropped", () => {
    const value = Array.from({ length: 6 }, (_, index) => ({
      id: `type-${index}`,
      name: `Type ${index}`,
    }))
    const pretty = JSON.stringify(value, null, 2)
    expect(compressStdout(pretty, pretty.length)).toEqual({ text: pretty, truncated: false })

    const cap = 250
    // The pretty form overflows the cap purely on whitespace; the compact form fits.
    expect(pretty.length).toBeGreaterThan(cap)
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(cap)

    const result = compressStdout(pretty, cap)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(JSON.stringify(value))
    // Round-trips to the same data — nothing was dropped.
    expect(JSON.parse(result.text)).toEqual(value)
  })

  test("keeps a valid whole-element array prefix when compaction is not enough", () => {
    const value = Array.from({ length: 200 }, (_, index) => ({
      id: `type-${index}`,
      name: `Type ${index}`,
    }))
    const result = compressStdout(JSON.stringify(value), CAP)

    expect(result.truncated).toBe(true)
    const parsed = JSON.parse(result.text) // must still be valid JSON
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.length).toBeLessThan(value.length)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    // The kept elements are the untouched leading originals.
    expect(parsed[0]).toEqual(value[0])
  })

  test("returns a valid diagnostic preview for a single oversized object", () => {
    const value = { id: "Customer", blob: "x".repeat(500), tail: "END" }
    const result = compressStdout(JSON.stringify(value), CAP)

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    expect(JSON.parse(result.text)).toMatchObject({
      _sixbOutputTruncated: true,
      topLevelKeys: ["id", "blob", "tail"],
    })
    expect(JSON.parse(result.text).preview).toStartWith(`{"id":"Customer"`)
  })

  test("middle-truncates non-JSON output, keeping head and tail", () => {
    const text = `START ${"a".repeat(500)} FINISH`
    const result = compressStdout(text, CAP)

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    expect(result.text.startsWith("START ")).toBe(true)
    expect(result.text.endsWith(" FINISH")).toBe(true)
  })
})

describe("bash tool timeout", () => {
  // Reproduce: put back 30_000 and 120_000 in bash.ts; the default and the clamp fail.
  test("gives a command 2 minutes by default and at most 10 when it asks for more", async () => {
    const { bash, timeouts } = harness()

    await bash({ command: "true" })
    await bash({ command: "true", timeoutMs: 300_000 })
    await bash({ command: "true", timeoutMs: 600_000 })
    await bash({ command: "true", timeoutMs: 3_600_000 })

    // An unusable value is the default too, as before.
    await bash({ command: "true", timeoutMs: 0 })

    expect(timeouts).toEqual([120_000, 300_000, 600_000, 600_000, 120_000])
  })

  test("tells the model its default and its maximum", () => {
    expect(BASH_TOOL_SPEC.description).toContain("2 minutes (120000 ms)")
    expect(BASH_TOOL_SPEC.description).toContain("up to 10 minutes (600000 ms)")
    expect(BASH_TOOL_SPEC.description).toContain("timedOut: true")
    expect(BASH_TOOL_SPEC.inputSchema.properties.timeoutMs.description).toContain("600000")
  })

  // Reproduce: drop the notice from execute in bash.ts; stderr is then the command's alone.
  test("says after how long a stopped command was stopped, and whether it can have longer", async () => {
    const stopped = { exitCode: 137, stdout: "compiling\n", stderr: "warning", timedOut: true }
    const { bash } = harness(stopped)

    const output = await bash({ command: "bun run build" })
    expect(output).toMatchObject({ exitCode: 137, stdout: "compiling\n", timedOut: true })
    expect(output.stderr).toBe(
      "warning\n[SixbAgent] The command was stopped after 2 minutes, its timeout. Pass a larger timeoutMs, up to 600000, to give it longer."
    )

    const atMost = await bash({ command: "bun run build", timeoutMs: 900_000 })
    expect(atMost.stderr).toEndWith(
      "stopped after 10 minutes, its timeout. That is the most a command can have: split the work or make it faster."
    )

    const finished = harness({ exitCode: 1, stdout: "", stderr: "error" })
    expect((await finished.bash({ command: "false" })).stderr).toBe("error")
  })
})

/** The bash tool on a sandbox that records each command's timeout and answers with `result`. */
function harness(result: Partial<CommandResult> = {}) {
  const timeouts: (number | undefined)[] = []
  const sandbox = {
    async runCommand(
      _command: string,
      _args?: readonly string[],
      options?: RunCommandOptions
    ): Promise<CommandResult> {
      timeouts.push(options?.timeout)
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...result }
    },
  } as unknown as Sandbox
  const tool = createBashTool(
    async () => ({ sandbox, contextDirectory: ".sixb/agent" }),
    new BackgroundCommands()
  )

  const bash = async (input: Record<string, unknown>) => {
    const parsed = tool.parseInput(input)
    const context = { signal: new AbortController().signal, callId: "call", toolCallId: "call" }
    return (await tool.execute(parsed, context)) as unknown as BashToolOutput
  }
  return { bash, timeouts }
}
