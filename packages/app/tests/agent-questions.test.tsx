import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render as mount } from "@testing-library/react"
import type { AgentConversationMessage } from "../src/agent/conversation"
import {
  answerText,
  askedQuestions,
  openQuestionMessageKey,
} from "../src/agent/questions/interpret"
import { QuestionCards, QuestionTurnContext } from "../src/agent/questions/question-card"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "getComputedStyle",
])

const year = { question: "Which year?", choices: ["2025", "2026"] }
const regions = { question: "Which regions?", choices: ["west", "east"], multiple: true }

describe("the Agent's questions", () => {
  test("read from ask's questions, or from an earlier ask_parent's one question", () => {
    expect(askedQuestions({ questions: [year, regions] })).toEqual([
      { question: "Which year?", choices: ["2025", "2026"], multiple: false },
      { question: "Which regions?", choices: ["west", "east"], multiple: true },
    ])
    expect(askedQuestions({ question: " Which edition? " })).toEqual([
      { question: "Which edition?", choices: [], multiple: false },
    ])
  })

  test("are answered in one message: alone as the answer, several each after its question", () => {
    const questions = askedQuestions({ questions: [year, regions] })
    expect(answerText(questions.slice(0, 1), [["2026"]])).toBe("2026")
    expect(answerText(questions, [["2026"], ["west", "east"]])).toBe(
      "Which year? 2026\nWhich regions? west, east"
    )
    // A question left unanswered is left out.
    expect(answerText(questions, [[], ["west"]])).toBe("Which regions? west")
  })

  test("wait for the user only in the conversation's last reply, once its turn ended", () => {
    const reply = (key: string): AgentConversationMessage =>
      ({
        key,
        id: key,
        role: "assistant",
        status: "complete",
        runId: "run",
        parts: [
          { type: "tool", toolName: "ask", state: "output-available", input: {}, output: {} },
        ],
        context: [],
        diagnostics: [],
      }) as unknown as AgentConversationMessage
    const user = { ...reply("u"), role: "user", parts: [] } as unknown as AgentConversationMessage
    const idle = { kind: "idle" } as never
    expect(openQuestionMessageKey([reply("a")], idle)).toBe("a")
    expect(openQuestionMessageKey([reply("a"), user], idle)).toBeNull()
    expect(openQuestionMessageKey([reply("a")], { kind: "responding" } as never)).toBeNull()
  })
})

describe("a question card", () => {
  const tool = (questions: unknown[]) => ({
    toolName: "ask",
    state: "output-available" as const,
    input: { questions },
    output: { status: "asked" },
  })

  // Removal proof: return the closed line whatever QuestionTurnContext says; the card then has no
  // choice to pick, and nothing is sent.
  test("with one question to pick from, sends the pick at once", () => {
    const answer = mock((_text: string) => {})
    const view = mount(
      <QuestionTurnContext.Provider value={{ open: true, answer }}>
        <QuestionCards tools={[tool([year])]} />
      </QuestionTurnContext.Provider>
    )
    try {
      fireEvent.click(view.getByRole("button", { name: "2026" }))
      expect(answer).toHaveBeenCalledWith("2026")
    } finally {
      view.unmount()
    }
  })

  // How a typed answer joins the picks is answerText's, tested above: happy-dom does not deliver
  // a controlled input's change to React here.
  test("with several, sends every answer with the button, each after its question", () => {
    const answer = mock((_text: string) => {})
    const view = mount(
      <QuestionTurnContext.Provider value={{ open: true, answer }}>
        <QuestionCards tools={[tool([year, regions])]} />
      </QuestionTurnContext.Provider>
    )
    try {
      fireEvent.click(view.getByRole("button", { name: "2026" }))
      fireEvent.click(view.getByRole("button", { name: "west" }))
      fireEvent.click(view.getByRole("button", { name: "east" }))
      // A single-choice question takes one pick: a second replaces the first.
      fireEvent.click(view.getByRole("button", { name: "2025" }))
      fireEvent.click(view.getByRole("button", { name: "Send answer" }))
      expect(answer).toHaveBeenCalledWith("Which year? 2025\nWhich regions? west, east")
      expect(answer).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  test("once answered, reads as a line with its questions", () => {
    const view = mount(
      <QuestionTurnContext.Provider value={{ open: false }}>
        <QuestionCards tools={[tool([year])]} />
      </QuestionTurnContext.Provider>
    )
    try {
      expect(view.container.textContent).toContain("Asked you")
      expect(view.container.textContent).toContain("Which year?")
      expect(view.queryByRole("button", { name: "2026" })).toBeNull()
    } finally {
      view.unmount()
    }
  })
})
