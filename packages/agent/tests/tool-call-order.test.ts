import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { BackgroundCommands } from "../src/background-commands"
import { createBashTool } from "../src/tools/bash"
import { WorkerTestModel } from "./worker-model-fixture"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Reproduce: run every call of a step at once in runModelLoop. The second command then reads the
// folder before the first has written the file, which it does after a short wait.
test("a command sees the file the command before it wrote in the same step", async () => {
  const result = await runModelLoop({
    model: modelCalling([
      { name: "bash", input: { command: "sleep 0.2; echo ready > notes.md" } },
      { name: "bash", input: { command: "cat notes.md" } },
    ]),
    messages: [{ role: "user", content: [{ type: "text", text: "Write it, then show it." }] }],
    tools: [await sandboxBash()],
    maxSteps: 3,
    signal: new AbortController().signal,
  })

  const shown = result.steps[0]?.content.find(
    (part) => part.type === "tool-result" && part.toolCallId === "call_1"
  )
  expect(shown).toMatchObject({ output: { type: "json", value: { stdout: "ready\n" } } })
})

async function sandboxBash() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-tool-order-")))
  roots.push(root)
  const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create({
    workingDirectory: root,
  })
  return createBashTool(
    async () => ({ sandbox, contextDirectory: ".sixb/agent" }),
    new BackgroundCommands()
  )
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
