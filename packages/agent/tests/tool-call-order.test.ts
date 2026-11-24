import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { BackgroundCommands } from "../src/background-commands"
import { createBashTool } from "../src/tools/bash"
import { SeenFiles } from "../src/tools/file-writes"
import { createReadTool } from "../src/tools/read"
import { createWriteTool } from "../src/tools/write"
import { WorkerTestModel } from "./worker-model-fixture"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Reproduce: run every call of a step at once in runModelLoop. The second command then reads the
// folder before the first has written the file, which it does after a short wait.
test("a command sees the file the command before it wrote in the same step", async () => {
  const { handle } = await sandbox()
  const result = await runModelLoop({
    model: modelCalling([
      { name: "bash", input: { command: "sleep 0.2; echo ready > notes.md" } },
      { name: "bash", input: { command: "cat notes.md" } },
    ]),
    messages: [{ role: "user", content: [{ type: "text", text: "Write it, then show it." }] }],
    tools: [createBashTool(handle, new BackgroundCommands())],
    maxSteps: 3,
    signal: new AbortController().signal,
  })

  const shown = result.steps[0]?.content.find(
    (part) => part.type === "tool-result" && part.toolCallId === "call_1"
  )
  expect(shown).toMatchObject({ output: { type: "json", value: { stdout: "ready\n" } } })
})

// Reproduce: let SeenFiles.get count the reads of the step asking. The read, done before the
// write, then counts as seen, and the write replaces a file the model wrote without seeing.
test("a write beside a read of its file waits for the model to see it", async () => {
  const { root, handle } = await sandbox()
  const page = `${Array.from({ length: 148 }, (_, index) => `line ${index + 1}`).join("\n")}\n`
  writeFileSync(join(root, "page.tsx"), page)
  const seenFiles = new SeenFiles()

  const result = await runModelLoop({
    model: modelCalling([
      { name: "read", input: { path: "page.tsx" } },
      { name: "write", input: { path: "page.tsx", content: "new\n" } },
    ]),
    messages: [{ role: "user", content: [{ type: "text", text: "Rewrite page.tsx." }] }],
    tools: [createReadTool(handle, seenFiles), createWriteTool(handle, seenFiles)],
    maxSteps: 3,
    signal: new AbortController().signal,
  })

  const written = result.steps[0]?.content.find(
    (part) => part.type === "tool-result" && part.toolCallId === "call_1"
  )
  expect(JSON.stringify(written)).toContain("you have not seen all of 'page.tsx'")
  expect(readFileSync(join(root, "page.tsx"), "utf8")).toBe(page)
})

async function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-tool-order-")))
  roots.push(root)
  const local = await new LocalSandboxFactory({ isolation: "none" }).create({
    workingDirectory: root,
  })
  return { root, handle: async () => ({ sandbox: local, contextDirectory: ".sixb/agent" }) }
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
