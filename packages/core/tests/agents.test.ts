import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  AgentDefinitionError,
  type AgentToolDefinition,
  createSixb,
  defineAgentTool,
  defineObjectType,
  prop,
} from "../src"
import { AgentToolResultValidationError } from "../src/agents/errors"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const tempRoots = new Set<string>()

const model = testLanguageModel()

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-agents-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}

function validateToolInput(input: unknown): void {
  const builder = defineAgentTool("search").description("Search.") as unknown as {
    input(input: unknown): void
  }
  builder.input(input)
}

describe("defineAgentTool", () => {
  test("builds an immutable definition with snapshotted input and output", async () => {
    const inputSchema = { query: "string", limit: "integer" } as const
    const handlerResult = { results: ["sixb"], limit: 3 }
    const searchKnowledge = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input(inputSchema)
      .run(() => handlerResult)

    ;(inputSchema as { query: string }).query = "boolean"

    expect(searchKnowledge.kind).toBe("agentTool")
    expect(searchKnowledge.name).toBe("search_knowledge")
    expect(searchKnowledge.description).toBe("Search project knowledge.")
    expect(searchKnowledge.input).toEqual({ query: "string", limit: "integer" })
    expect(Object.isFrozen(searchKnowledge)).toBe(true)
    expect(Object.isFrozen(searchKnowledge.input)).toBe(true)

    const result = await searchKnowledge.handler({
      input: { query: "sixb", limit: 3 },
    } as never)
    expect(result).toEqual({ results: ["sixb"], limit: 3 })
    expect(result).not.toBe(handlerResult)
    handlerResult.results.push("mutated")
    expect(result).toEqual({ results: ["sixb"], limit: 3 })

    const invalidResult = defineAgentTool("invalid_result")
      .description("Return an invalid result.")
      .input({})
      .run((() => ({ value: undefined })) as never)

    const invalidResultPromise = invalidResult.handler({ input: {} } as never)
    await expect(invalidResultPromise).rejects.toBeInstanceOf(AgentToolResultValidationError)
    await expect(invalidResultPromise).rejects.toMatchObject({
      toolName: "invalid_result",
      reason: "result.value is undefined",
    })
  })

  test("snapshots file-aware results and rejects malformed file references", async () => {
    const digest = `sha256:${"a".repeat(64)}` as const
    const handlerResult = {
      kind: "agentToolResult",
      content: [
        { type: "text", text: "Created an image." },
        {
          type: "file",
          fileRef: {
            blobId: `blob_${"a".repeat(64)}`,
            digest,
            sizeBytes: 8,
            fileName: "image.png",
            mediaType: "image/png",
          },
        },
      ],
    } as const
    const createImage = defineAgentTool("create_image")
      .description("Create an image.")
      .input({})
      .run(() => handlerResult)

    const result = await createImage.handler({ input: {} } as never)
    expect(result).toEqual(JSON.parse(JSON.stringify(handlerResult)))
    expect(result).not.toBe(handlerResult)

    const malformed = defineAgentTool("malformed_image")
      .description("Return a malformed image result.")
      .input({})
      .run((() => ({
        kind: "agentToolResult",
        content: [
          {
            type: "file",
            fileRef: {
              blobId: "blob_wrong",
              digest,
              sizeBytes: 8,
            },
          },
        ],
      })) as never)

    await expect(malformed.handler({ input: {} } as never)).rejects.toMatchObject({
      toolName: "malformed_image",
      reason: "result.content[0].fileRef must be a valid FileRef",
    })

    const unsupportedField = defineAgentTool("unsupported_rich_field")
      .description("Return an unsupported rich result field.")
      .input({})
      .run((() => ({ ...handlerResult, structuredContent: { stale: true } })) as never)
    await expect(unsupportedField.handler({ input: {} } as never)).rejects.toMatchObject({
      toolName: "unsupported_rich_field",
      reason: "result.structuredContent is not supported",
    })

    const unsupportedContentField = defineAgentTool("unsupported_content_field")
      .description("Return an unsupported rich content field.")
      .input({})
      .run((() => ({
        kind: "agentToolResult",
        content: [{ type: "text", text: "Created.", ignored: true }],
      })) as never)
    await expect(unsupportedContentField.handler({ input: {} } as never)).rejects.toMatchObject({
      toolName: "unsupported_content_field",
      reason: "result.content[0].ignored is not supported",
    })
  })

  test("deeply snapshots and freezes nested input schemas", () => {
    const values = ["quick", "deep"]
    const input = {
      mode: { type: "enum" as const, valueType: "string" as const, values },
    }
    const tool = defineAgentTool("search_mode")
      .description("Select a search mode.")
      .input(input)
      .run(() => null)

    values.push("mutated")

    expect(tool.input.mode.values).toEqual(["quick", "deep"])
    expect(Object.isFrozen(tool.input.mode)).toBe(true)
    expect(Object.isFrozen(tool.input.mode.values)).toBe(true)
  })

  test("rejects invalid and reserved names", () => {
    const validateName = (name: string): void => {
      defineAgentTool(name)
    }
    for (const name of ["", "1search", "search knowledge", "a".repeat(65)]) {
      expect(() => validateName(name)).toThrow(AgentDefinitionError)
    }
    for (const name of ["bash", "read", "view_file", "spawn_agent", "wait_agent"]) {
      expect(() => validateName(name)).toThrow("reserved by the framework")
    }
  })

  test("rejects empty descriptions, invalid schemas, and missing handlers", () => {
    const validateHandler = (handler: unknown): void => {
      const builder = defineAgentTool("search").description("Search.").input({}) as unknown as {
        run(handler: unknown): void
      }
      builder.run(handler)
    }

    expect(() => defineAgentTool("search").description(" ")).toThrow(AgentDefinitionError)
    expect(() => validateToolInput({ query: "unknown" })).toThrow(
      "input.query must be a valid Sixb schema"
    )
    expect(() =>
      validateToolInput({ mode: { type: "enum", valueType: "string", values: [] } })
    ).toThrow("input.mode must be a valid Sixb schema")
    expect(() => validateHandler(undefined)).toThrow("handler must be a function")

    const mutableInput = { query: "string" }
    const runBuilder = defineAgentTool("mutable_input")
      .description("Catch mutations between builder stages.")
      .input(mutableInput as { query: "string" })
    mutableInput.query = "unknown"
    expect(() => runBuilder.run(() => null)).toThrow("input.query must be a valid Sixb schema")
  })

  test("rejects malformed nested input schemas", () => {
    const recursive: Record<string, unknown> = { type: "array" }
    recursive.items = recursive
    const sparseEnumValues = new Array<string>(1)

    const invalidInputs: readonly [input: unknown, path: string][] = [
      [{ items: { type: "array" } }, "input.items.items"],
      [{ lookup: { type: "map", keySchema: "integer", valueSchema: "string" } }, "input.lookup"],
      [
        { filters: { type: "object", properties: { active: { required: true } } } },
        "input.filters.properties.active",
      ],
      [{ reference: { type: "valueTypeRef", valueTypeId: " " } }, "input.reference"],
      [{ mode: { type: "enum", valueType: "string", values: ["quick", "quick"] } }, "input.mode"],
      [{ mode: { type: "enum", valueType: "string", values: sparseEnumValues } }, "input.mode"],
      [{ recursive }, "input.recursive.items"],
    ]

    for (const [input, path] of invalidInputs) {
      expect(() => validateToolInput(input)).toThrow(`${path} must be a valid Sixb schema`)
    }
  })
})

describe("project Agent configuration", () => {
  test("does not import the retired agents discovery directory", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(
      projectRoot,
      "agents/old.ts",
      'throw new Error("must not import legacy definitions")'
    )
    const host = await createSixb({
      projectRoot,
      ontologies: [Room],
      models: { language: [model] },
      ...createTestRuntimeDeps(),
    })
    expect("agents" in host.definitions).toBe(false)
    expect(createTestSixb(host).agent.get()?.name).toBe("Sixb")
  })

  test("revalidates and snapshots project tools at startup", async () => {
    const projectRoot = await createTempProjectRoot()
    const tool: AgentToolDefinition = {
      kind: "agentTool",
      name: "lookup",
      description: "Look up a value.",
      input: { query: "string" },
      handler: async ({ input }) => ({ query: String(input.query) }),
    }
    const config = {
      projectRoot,
      ontologies: [Room],
      models: { language: [model] },
      ...createTestRuntimeDeps(),
    }
    await expect(createSixb({ ...config, tools: [{ ...tool, name: "bash" }] })).rejects.toThrow(
      /reserved/
    )
    const host = await createSixb({ ...config, tools: [tool] })
    const registered = host.definitions.tools.getByName("lookup")!
    expect(Object.isFrozen(registered)).toBe(true)
    expect(Object.isFrozen(registered.input)).toBe(true)
    expect(registered).not.toBe(tool)
    expect(await registered.handler({ input: { query: "sixb" } } as never)).toEqual({
      query: "sixb",
    })
  })
})
