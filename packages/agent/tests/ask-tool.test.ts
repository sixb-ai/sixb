import { describe, expect, test } from "bun:test"
import { agentQuestionsText } from "@sixb/core/internal/agents"
import type { ModelTool } from "@sixb/core/models"
import { type AskInput, createAskUserTool, stepAskedUser } from "../src/ask-tool"

const ask = createAskUserTool()

function parse(tool: ModelTool<AskInput>, input: unknown): AskInput | string {
  try {
    return tool.parseInput(input)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe("ask", () => {
  test("takes one to four questions, each with up to four choices", () => {
    expect(
      parse(ask, {
        questions: [
          { question: " Which environment? ", choices: ["staging", " production "] },
          { question: "Which reports?", choices: ["daily", "weekly"], multiple: true },
          { question: "Anything else?" },
        ],
      })
    ).toEqual({
      questions: [
        { question: "Which environment?", choices: ["staging", "production"] },
        { question: "Which reports?", choices: ["daily", "weekly"], multiple: true },
        { question: "Anything else?" },
      ],
    })
  })

  test("refuses no question, more than four, or a fifth choice, saying the bound", () => {
    expect(parse(ask, { questions: [] })).toBe("[SixbAgent] ask expects 1 to 4 questions.")
    expect(parse(ask, { questions: Array(5).fill({ question: "Q?" }) })).toBe(
      "[SixbAgent] ask expects 1 to 4 questions."
    )
    expect(
      parse(ask, { questions: [{ question: "Q?", choices: ["a", "b", "c", "d", "e"] }] })
    ).toBe("[SixbAgent] questions[0].choices must be up to 4 non-empty answers.")
    expect(parse(ask, { question: "Q?" })).toBe("[SixbAgent] ask expects { questions: [...] }.")
  })

  test("keeps multiple only where there are choices to pick several of", () => {
    expect(parse(ask, { questions: [{ question: "Q?", multiple: true }] })).toEqual({
      questions: [{ question: "Q?" }],
    })
  })

  test("reads as one text to a sub-agent's parent: its choices beside it, numbered when several", () => {
    expect(agentQuestionsText([{ question: "Which edition?" }])).toBe("Which edition?")
    expect(
      agentQuestionsText([
        { question: "Which environment?", choices: ["staging", "production"] },
        { question: "Which reports?", choices: ["daily", "weekly"], multiple: true },
      ])
    ).toBe(
      "1. Which environment? (staging / production)\n2. Which reports? (any of: daily / weekly)"
    )
  })

  // Reproduce: drop the output type check from stepAskedUser; a call refused for its input then
  // ends the turn on a question nobody sees.
  test("ends the Agent's turn only on a question it asked, not on one refused for its input", () => {
    const step = (output: { type: string }) => ({
      content: [{ type: "tool-result", toolName: "ask", output }],
    })
    expect(stepAskedUser(step({ type: "json" }))).toBe(true)
    expect(stepAskedUser(step({ type: "error-text" }))).toBe(false)
    expect(
      stepAskedUser({
        content: [{ type: "tool-result", toolName: "read", output: { type: "json" } }],
      })
    ).toBe(false)
  })
})
