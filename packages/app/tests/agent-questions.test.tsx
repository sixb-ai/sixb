import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render as mount } from "@testing-library/react"
import type { AgentConversationMessage } from "../src/agent/conversation"
import {
  type AskedQuestion,
  answerText,
  askedQuestions,
  openQuestion,
} from "../src/agent/questions/interpret"
import { QuestionCards, QuestionTurnContext } from "../src/agent/questions/question-card"
import { QuestionComposer } from "../src/agent/questions/question-composer"
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
          {
            type: "tool",
            toolName: "ask",
            state: "output-available",
            input: { questions: [{ question: "Which year?" }] },
            output: {},
          },
        ],
        context: [],
        diagnostics: [],
      }) as unknown as AgentConversationMessage
    const user = { ...reply("u"), role: "user", parts: [] } as unknown as AgentConversationMessage
    const idle = { kind: "idle" } as never
    expect(openQuestion([reply("a")], idle)?.messageKey).toBe("a")
    expect(openQuestion([reply("a"), user], idle)).toBeNull()
    expect(openQuestion([reply("a")], { kind: "responding" } as never)).toBeNull()
  })
})

describe("the composer, become the question", () => {
  const compose = (questions: readonly AskedQuestion[]) => {
    const answer = mock((_text: string) => {})
    const dismiss = mock(() => {})
    const view = mount(
      <QuestionComposer questions={questions} onAnswer={answer} onDismiss={dismiss} />
    )
    return { view, answer, dismiss }
  }
  const asked = (input: unknown) => askedQuestions({ questions: [input] })

  // Removal proof: drop the `commit` call for a single choice in QuestionComposer's `choose`;
  // picking then sends nothing.
  test("with one question to pick from, sends the pick at once", () => {
    const { view, answer } = compose(asked(year))
    try {
      fireEvent.click(view.getByRole("button", { name: /2026/ }))
      expect(answer).toHaveBeenCalledWith("2026")
    } finally {
      view.unmount()
    }
  })

  test("asks several one at a time, then sends them together from the last", () => {
    const questions = askedQuestions({ questions: [year, regions] })
    const { view, answer } = compose(questions)
    try {
      fireEvent.click(view.getByRole("button", { name: /2025/ }))
      // The second question, with the way back to the first.
      expect(view.getByText("Which regions?")).toBeDefined()
      expect(view.getByRole("button", { name: "Previous question" })).toBeDefined()
      fireEvent.click(view.getByRole("button", { name: /west/ }))
      fireEvent.click(view.getByRole("button", { name: /east/ }))
      fireEvent.click(view.getByRole("button", { name: "Send answer" }))
      expect(answer).toHaveBeenCalledWith("Which year? 2025\nWhich regions? west, east")
    } finally {
      view.unmount()
    }
  })

  test("picks with a number key, and sets the question aside with Escape", () => {
    const { view, answer, dismiss } = compose(asked(year))
    try {
      const section = view.getByRole("region")
      fireEvent.keyDown(section, { key: "2" })
      expect(answer).toHaveBeenCalledWith("2026")
      fireEvent.keyDown(section, { key: "Escape" })
      expect(dismiss).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })
})

describe("the question in the reply", () => {
  const tool = {
    toolName: "ask",
    state: "output-available" as const,
    input: { questions: [year] },
    output: { status: "asked" },
  }

  test("leaves the asking to the composer, and reads as asked once answered", () => {
    const asking = mount(
      <QuestionTurnContext.Provider value={{ open: true, answering: true }}>
        <QuestionCards tools={[tool]} />
      </QuestionTurnContext.Provider>
    )
    try {
      expect(asking.container.textContent).toBe("")
    } finally {
      asking.unmount()
    }
    const answered = mount(
      <QuestionTurnContext.Provider value={{ open: false }}>
        <QuestionCards tools={[tool]} />
      </QuestionTurnContext.Provider>
    )
    try {
      expect(answered.container.textContent).toBe("Asked youWhich year?")
    } finally {
      answered.unmount()
    }
  })
})
