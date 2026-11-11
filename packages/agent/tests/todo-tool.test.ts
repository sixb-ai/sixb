import { describe, expect, test } from "bun:test"
import { createTodoTool, type TodoInput } from "../src/todo-tool"

const todo = createTodoTool()

const context = { signal: new AbortController().signal, callId: "call", toolCallId: "plan" }

function parse(input: unknown): TodoInput | string {
  try {
    return todo.parseInput(input)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** What the call keeps, and what the model reads of it. */
async function run(input: unknown) {
  const output = await todo.execute(todo.parseInput(input), context)
  const modelOutput = await todo.toModelOutput?.(output, context)
  return { output, modelOutput }
}

describe("todo", () => {
  test("takes the whole plan, its contents trimmed", () => {
    expect(
      parse({
        todos: [
          { content: " Check the March invoices ", status: "in_progress" },
          { content: "Send the reminders", status: "pending" },
          { content: "Read the contracts", status: "completed" },
        ],
      })
    ).toEqual({
      todos: [
        { content: "Check the March invoices", status: "in_progress" },
        { content: "Send the reminders", status: "pending" },
        { content: "Read the contracts", status: "completed" },
      ],
    })
  })

  // Reproduce: drop the unknown-key checks from parseTodoInput; these then parse.
  test("refuses unknown keys, on the call and on an item", () => {
    expect(parse({ todos: [], explanation: "Why" })).toBe(
      "[SixbAgent] todo expects { todos: [...] }."
    )
    expect(parse({ todos: [{ content: "Check", status: "pending", priority: "high" }] })).toBe(
      "[SixbAgent] todos[0] must be { content, status }."
    )
    expect(parse({ plan: [] })).toBe("[SixbAgent] todo expects { todos: [...] }.")
  })

  // Reproduce: drop the item count or the length check from parseTodoInput; these then parse.
  test("refuses more than 30 items, and an item empty or over 200 characters", () => {
    const item = { content: "Check", status: "pending" }
    expect(parse({ todos: Array(30).fill(item) })).toMatchObject({ todos: { length: 30 } })
    expect(parse({ todos: Array(31).fill(item) })).toBe(
      "[SixbAgent] todo expects a list of up to 30 items."
    )
    expect(parse({ todos: "Check" })).toBe("[SixbAgent] todo expects a list of up to 30 items.")

    expect(parse({ todos: [{ content: "   ", status: "pending" }] })).toBe(
      "[SixbAgent] todos[0].content must be 1 to 200 characters."
    )
    expect(parse({ todos: [item, { content: "a".repeat(201), status: "pending" }] })).toBe(
      "[SixbAgent] todos[1].content must be 1 to 200 characters."
    )
    expect(parse({ todos: [{ content: 7, status: "pending" }] })).toBe(
      "[SixbAgent] todos[0].content must be 1 to 200 characters."
    )
    // Counted after trimming, in characters as the schema counts them, not UTF-16 units.
    // Reproduce: measure content.length in parseTodoInput; the emoji then count twice.
    expect(parse({ todos: [{ content: ` ${"a".repeat(200)} `, status: "pending" }] })).toEqual({
      todos: [{ content: "a".repeat(200), status: "pending" }],
    })
    expect(parse({ todos: [{ content: "📄".repeat(200), status: "pending" }] })).toEqual({
      todos: [{ content: "📄".repeat(200), status: "pending" }],
    })
  })

  // Reproduce: drop the status check from parseTodoInput; these then parse.
  test("takes pending, in_progress and completed, and no other status", () => {
    for (const status of ["cancelled", "blocked", "done", null]) {
      expect(parse({ todos: [{ content: "Check", status }] })).toBe(
        "[SixbAgent] todos[0].status must be pending, in_progress or completed."
      )
    }
  })

  test("asks for the plan first, as results in the user's words, kept current", () => {
    // Removal proof: drop a sentence from the description; its line fails. Measured live, without
    // them, models planned after the work, or with items like "Read the data model".
    const description = todo.description

    expect(description).toContain("Make it your first call, before you look anything up")
    expect(description).toContain("Skip it when one lookup or a short reply answers the request.")
    expect(description).toContain("Each item is a short result the user asked for")
    expect(description).toContain("Leave out work they didn't ask for")
    expect(description).toContain("Update it after each item, not all at the end")
    expect(description).toContain("Before your final answer, every item is completed")
    expect(description).toContain("Don't repeat the plan in your messages")
  })

  test("holds the model to the same shape where the provider can", () => {
    expect(todo.strict).toBe(true)
    expect(todo.inputSchema).toMatchObject({
      required: ["todos"],
      additionalProperties: false,
      properties: {
        todos: {
          maxItems: 30,
          items: {
            required: ["content", "status"],
            additionalProperties: false,
            properties: {
              content: { minLength: 1, maxLength: 200 },
              status: { enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
    })
  })

  test("keeps counts, and the model reads them as one line", async () => {
    expect(
      await run({
        todos: [
          { content: "Read the contracts", status: "completed" },
          { content: "Check the March invoices", status: "in_progress" },
          { content: "Compare the totals", status: "completed" },
          { content: "Send the reminders", status: "pending" },
          { content: "Write the summary", status: "pending" },
        ],
      })
    ).toEqual({
      output: { total: 5, completed: 2, inProgress: ["Check the March invoices"] },
      modelOutput: {
        type: "text",
        value: "Plan updated: 2 of 5 completed. In progress: Check the March invoices.",
      },
    })

    expect(
      await run({
        todos: [
          { content: "Check the March invoices", status: "in_progress" },
          { content: "Check the April invoices", status: "in_progress" },
        ],
      })
    ).toMatchObject({
      modelOutput: {
        value:
          "Plan updated: 0 of 2 completed. In progress: Check the March invoices; Check the April invoices.",
      },
    })

    expect(
      await run({ todos: [{ content: "Read the contracts", status: "completed" }] })
    ).toMatchObject({ modelOutput: { value: "Plan updated: 1 of 1 completed." } })

    // Reproduce: always append "." in todoModelText; this line then ends with "..".
    expect(
      await run({ todos: [{ content: "Call the bank first.", status: "in_progress" }] })
    ).toMatchObject({
      modelOutput: { value: "Plan updated: 0 of 1 completed. In progress: Call the bank first." },
    })
  })

  test("clears the plan with an empty list", async () => {
    expect(await run({ todos: [] })).toEqual({
      output: { total: 0, completed: 0, inProgress: [] },
      modelOutput: { type: "text", value: "Plan cleared." },
    })
  })

  test("answers the same plan with the same bytes, whenever it runs", async () => {
    const plan = {
      todos: [
        { content: "Check the March invoices", status: "in_progress" },
        { content: "Send the reminders", status: "pending" },
      ],
    }
    const first = await run(plan)
    const second = await run(structuredClone(plan))

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
