import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessageCircleQuestion } from "lucide-react"
import { createContext, useContext, useId, useState } from "react"
import { ACTIVITY_STATUS_ROW_CLASS_NAME } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { type AskedQuestion, answerText, askedQuestions } from "./interpret"

/**
 * Whether the reply a card is in asks the reader now: its question is the conversation's last word,
 * and `answer` sends the reader's answer as their next message. Without `answer`, as for an
 * observer, the card only reads.
 */
export interface QuestionTurn {
  readonly open: boolean
  readonly answer?: (text: string) => void
}

export const QuestionTurnContext = createContext<QuestionTurn>({ open: false })

/** The Agent's questions to the user in one reply, each call its own card. */
export function QuestionCards({ tools }: { readonly tools: readonly NormalizedTool[] }) {
  if (tools.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {tools.map((tool, index) => (
        // A reply's calls never reorder: their order is their identity.
        <QuestionCard key={index} tool={tool} />
      ))}
    </div>
  )
}

function QuestionCard({ tool }: { readonly tool: NormalizedTool }) {
  const turn = useContext(QuestionTurnContext)
  const messages = useAgentMessages().questions
  const questions = askedQuestions(tool.input)
  if (questions.length === 0) return null

  // Answered, or no longer the last word: a line in the work, the questions after it.
  if (!turn.open || !turn.answer) {
    return (
      <div className="min-w-0">
        <p className={ACTIVITY_STATUS_ROW_CLASS_NAME}>
          <MessageCircleQuestion className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium">
            {turn.open ? messages.waiting : messages.asked}
          </span>
        </p>
        <ul className="mt-1 space-y-0.5 pl-5 text-[13px] text-muted-foreground">
          {questions.map((question) => (
            <li key={question.question} className="break-words">
              {question.question}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return <OpenQuestions questions={questions} answer={turn.answer} />
}

function OpenQuestions({
  questions,
  answer,
}: {
  readonly questions: readonly AskedQuestion[]
  readonly answer: (text: string) => void
}) {
  const messages = useAgentMessages().questions
  const [picked, setPicked] = useState<readonly (readonly string[])[]>(() =>
    questions.map(() => [])
  )
  const [typed, setTyped] = useState<readonly string[]>(() => questions.map(() => ""))
  const [sent, setSent] = useState(false)
  // One question with one answer to pick: picking it answers.
  const pickSends = questions.length === 1 && !questions[0]?.multiple

  const answers = questions.map((_, index) => [
    ...(picked[index] ?? []),
    ...((typed[index] ?? "").trim() ? [typed[index] ?? ""] : []),
  ])
  const text = answerText(questions, answers)

  const send = (value: string) => {
    if (!value.trim() || sent) return
    setSent(true)
    answer(value)
  }

  const pick = (index: number, choice: string) => {
    const question = questions[index]
    if (!question) return
    if (pickSends) {
      send(answerText(questions, [[choice]]))
      return
    }
    setPicked((current) =>
      current.map((choices, at) => {
        if (at !== index) return choices
        if (!question.multiple) return choices.includes(choice) ? [] : [choice]
        return choices.includes(choice)
          ? choices.filter((entry) => entry !== choice)
          : [...choices, choice]
      })
    )
  }

  return (
    <section
      aria-label={messages.card(questions.length)}
      className="min-w-0 rounded-2xl bg-card p-4 text-card-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.03),0_4px_16px_rgb(0_0_0/0.035)] sm:p-5 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.09)]"
    >
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <Question
            key={question.question}
            question={question}
            picked={picked[index] ?? []}
            typed={typed[index] ?? ""}
            disabled={sent}
            onPick={(choice) => pick(index, choice)}
            onType={(value) =>
              setTyped((current) => current.map((entry, at) => (at === index ? value : entry)))
            }
            onEnter={() => send(text)}
          />
        ))}
      </div>
      {pickSends && !typed[0]?.trim() ? null : (
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={sent || !text}
            onClick={() => send(text)}
            className="h-8 rounded-full px-4 shadow-none"
          >
            {sent ? messages.sending : messages.send}
          </Button>
        </div>
      )}
    </section>
  )
}

function Question({
  question,
  picked,
  typed,
  disabled,
  onPick,
  onType,
  onEnter,
}: {
  readonly question: AskedQuestion
  readonly picked: readonly string[]
  readonly typed: string
  readonly disabled: boolean
  readonly onPick: (choice: string) => void
  readonly onType: (value: string) => void
  readonly onEnter: () => void
}) {
  const messages = useAgentMessages().questions
  const inputId = useId()
  return (
    <div className="min-w-0">
      <h3 className="flex min-w-0 items-start gap-2 text-[15px] leading-snug font-semibold tracking-[-0.01em] text-foreground">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
        <span className="min-w-0 break-words">{question.question}</span>
      </h3>
      {question.multiple ? (
        <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">{messages.pickAny}</p>
      ) : null}
      {question.choices.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-2 pl-3.5">
          {question.choices.map((choice) => {
            const selected = picked.includes(choice)
            return (
              <button
                key={choice}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onPick(choice)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground hover:bg-muted"
                )}
              >
                {choice}
              </button>
            )
          })}
        </div>
      ) : null}
      <label htmlFor={inputId} className="sr-only">
        {messages.typeAnswer}
      </label>
      <input
        id={inputId}
        type="text"
        value={typed}
        disabled={disabled}
        placeholder={question.choices.length > 0 ? messages.typeOther : messages.typeAnswer}
        onChange={(event) => onType(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onEnter()
          }
        }}
        className="mt-2.5 ml-3.5 h-8 w-[calc(100%-0.875rem)] rounded-lg border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
      />
    </div>
  )
}
