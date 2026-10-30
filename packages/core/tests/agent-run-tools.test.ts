import { describe, expect, test } from "bun:test"
import { InMemoryBlobStorage } from "../src"
import {
  AgentToolPublicError,
  type AgentToolRuntimeFacade,
  defineAgentTool,
  runAgentTool,
} from "../src/agents"
import { noopLogger } from "../src/logging/console-logger"

// How one call of a project tool runs, wherever its run's session is: the session suite proves
// each session calls it as its run.

const run = { kind: "conversation", id: "run-1", threadId: "thread-1" } as const

function call(
  definition: Parameters<typeof runAgentTool>[0]["definition"],
  options: { readonly maxFileBytes?: number } = {}
) {
  const store = new InMemoryBlobStorage()
  const stored: string[] = []
  const result = runAgentTool({
    definition,
    valueTypesById: new Map(),
    call: { toolName: definition.name, toolCallId: "call-1", input: {} },
    signal: new AbortController().signal,
    run,
    sixb: {} as AgentToolRuntimeFacade,
    logger: noopLogger,
    attachments: {
      async open() {
        return null
      },
    },
    files: {
      async put(input) {
        const file = await store.put(input)
        stored.push(file.blobId)
        return file
      },
    },
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  })
  return { result, stored }
}

describe("a project tool's call", () => {
  // Removal proof: drop the onBytes check in runAgentTool; the third file is stored, and the run's
  // budget is only found exceeded once the runner copies it, after the tool's work is done.
  test("refuses the file that would pass what the run has left, before storing it", async () => {
    const refusals: unknown[] = []
    const tool = defineAgentTool("export_rows")
      .description("Export rows.")
      .input({})
      .run(async ({ files }) => {
        for (const name of ["a.csv", "b.csv", "c.csv"]) {
          try {
            await files.put({ body: new TextEncoder().encode("1234"), fileName: name })
          } catch (error) {
            refusals.push(error)
          }
        }
        return { exported: true }
      })

    const { result, stored } = call(tool, { maxFileBytes: 10 })

    expect((await result).files).toHaveLength(2)
    expect(stored).toHaveLength(2)
    expect(refusals).toEqual([expect.any(AgentToolPublicError)])
  })
})
