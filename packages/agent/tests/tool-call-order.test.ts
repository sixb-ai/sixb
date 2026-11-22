import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { BackgroundCommands } from "../src/background-commands"
import { createBashTool } from "../src/tools/bash"
import { FileReadLedger } from "../src/tools/file-writes"
import { createWriteTool } from "../src/tools/write"
import { WorkerTestModel } from "./worker-model-fixture"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Reproduce: run every call of a step at once in runModelLoop. The command then reads the folder
// before the file is written: on a local sandbox, every time.
test("a command sees the file written before it in the same step", async () => {
  const tools = await sandboxTools()

  const result = await runModelLoop({
    model: modelCalling([
      { name: "write", input: { path: "notes.md", content: "ready\n" } },
      { name: "bash", input: { command: "cat notes.md" } },
    ]),
    messages: [{ role: "user", content: [{ type: "text", text: "Write it, then show it." }] }],
    tools,
    maxSteps: 3,
    signal: new AbortController().signal,
  })

  const shown = result.steps[0]?.content.find(
    (part) => part.type === "tool-result" && part.toolName === "bash"
  )
  expect(shown).toMatchObject({ output: { type: "json", value: { stdout: "ready\n" } } })
})

async function sandboxTools() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-tool-order-")))
  roots.push(root)
  const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create({
    workingDirectory: root,
  })
  const handle = async () => ({ sandbox, contextDirectory: ".sixb/agent" })
  return [
    createWriteTool(handle, new FileReadLedger()),
    createBashTool(handle, new BackgroundCommands()),
  ]
}

/** A model whose first step makes these calls, and whose second answers. */
function modelCalling(calls: readonly { readonly name: string; readonly input: object }[]) {
  let step = 0
  const model = new WorkerTestModel()
  model.stream = async () => {
    const events: LanguageModelStreamEvent[] =
      step++ === 0
        ? [
            ...calls.map((call, index) => ({
              type: "tool-call" as const,
              toolCallId: `call_${index}`,
              toolName: call.name,
              input: JSON.stringify(call.input),
            })),
            { type: "finish", finishReason: "tool-calls", usage: {} },
          ]
        : [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Done." },
            { type: "text-end", id: "answer" },
            { type: "finish", finishReason: "stop", usage: {} },
          ]
    return {
      events: (async function* () {
        yield { type: "stream-start" } as const
        yield* events
      })(),
    }
  }
  return model
}
