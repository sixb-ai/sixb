import { AgentToolPublicError } from "@sixb/core"
import { isJsonObject, type JsonObject, type ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "./model-adapters"

const TODO_TOOL_NAME = "todo"

const TODO_LIMITS = { items: 30, characters: 200 } as const

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const

type TodoStatus = (typeof TODO_STATUSES)[number]

interface TodoItem {
  readonly content: string
  readonly status: TodoStatus
}

export interface TodoInput {
  readonly todos: readonly TodoItem[]
}

/** What a call keeps: its counts. The app and the TUI read the items from the call's input. */
export type TodoOutput = {
  readonly total: number
  readonly completed: number
  readonly inProgress: string[]
}

/**
 * The Agent's plan for the request at hand, which the user follows while it works. It keeps
 * nothing: each call sends the whole list, so the latest call is the plan, and a thread replays
 * or reverts it with its messages.
 */
export function createTodoTool(): ModelTool<TodoInput, TodoOutput> {
  return {
    name: TODO_TOOL_NAME,
    strict: true,
    description: [
      "Keep your plan for the current request. The user sees it as your progress while you work.",
      "",
      "Make it your first call, before you look anything up, when the request takes 3 or more steps or asks for several things. Skip it when one lookup or a short reply answers the request.",
      "",
      '- Each item is a short result the user asked for, in their language and with the names they see in the application, such as "Open quotes for each customer". Leave out work they didn\'t ask for, like learning how the data is organized, and never write commands, paths, tool or type names.',
      "- Send the whole list on every call: it replaces the previous one, and an empty list clears it.",
      "- Update it after each item, not all at the end: in one call, mark the item completed as soon as it is done and the next one in_progress. Before your final answer, every item is completed, or removed if it no longer applies.",
      "- Call it again once the user answers a question you asked: the plan shows only while you work after their last message.",
      "- Don't repeat the plan in your messages: the user already sees it.",
    ].join("\n"),
    inputSchema: todoInputSchema(),
    parseInput: parseTodoInput,
    execute: async ({ todos }) => ({
      total: todos.length,
      completed: todos.filter((todo) => todo.status === "completed").length,
      inProgress: todos.filter((todo) => todo.status === "in_progress").map((todo) => todo.content),
    }),
    toModelOutput: (output) => ({ type: "text", value: todoModelText(output) }),
    errorText: agentToolErrorText,
  }
}

/** What the model reads back: a line of counts, never the list it just sent. */
function todoModelText({ total, completed, inProgress }: TodoOutput): string {
  if (total === 0) return "Plan cleared."

  const counts = `Plan updated: ${completed} of ${total} completed.`
  if (inProgress.length === 0) return counts

  // An item that already ends a sentence keeps its own mark: never "..".
  const items = inProgress.join("; ")
  return `${counts} In progress: ${items}${/[.!?…]$/.test(items) ? "" : "."}`
}

function todoInputSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: TODO_LIMITS.items,
        description:
          "The whole plan, in order. It replaces the previous one; an empty list clears it.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: TODO_LIMITS.characters,
              description: "One step, in the user's language and in plain words about their goal.",
            },
            status: { type: "string", enum: [...TODO_STATUSES] },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  }
}

function parseTodoInput(value: unknown): TodoInput {
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "todos")) {
    throw todoError("todo expects { todos: [...] }.")
  }

  const { todos } = value
  if (!Array.isArray(todos) || todos.length > TODO_LIMITS.items) {
    throw todoError(`todo expects a list of up to ${TODO_LIMITS.items} items.`)
  }

  return {
    todos: todos.map((entry, index): TodoItem => {
      const at = `todos[${index}]`
      if (
        !isJsonObject(entry) ||
        Object.keys(entry).some((key) => key !== "content" && key !== "status")
      ) {
        throw todoError(`${at} must be { content, status }.`)
      }

      const content = typeof entry.content === "string" ? entry.content.trim() : ""
      // JSON Schema's maxLength counts code points, as this does.
      const characters = [...content].length
      if (characters === 0 || characters > TODO_LIMITS.characters) {
        throw todoError(`${at}.content must be 1 to ${TODO_LIMITS.characters} characters.`)
      }

      const { status } = entry
      if (!isTodoStatus(status)) {
        throw todoError(`${at}.status must be pending, in_progress or completed.`)
      }

      return { content, status }
    }),
  }
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return TODO_STATUSES.some((status) => status === value)
}

function todoError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] ${message}`)
}
