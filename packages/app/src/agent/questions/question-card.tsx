import { MessageCircleQuestion } from "lucide-react"
import { createContext, useContext } from "react"
import { ACTIVITY_STATUS_ROW_CLASS_NAME } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { askedQuestions } from "./interpret"

/**
 * Whether the reply a line is in asks the reader now: its question is the conversation's last word,
 * answered in the composer, which becomes the question (`QuestionComposer`). `answering` when the
 * reader may answer there; otherwise, as for an observer, someone else's answer is awaited.
 */
export interface QuestionTurn {
  readonly open: boolean
  readonly answering?: boolean
}

export const QuestionTurnContext = createContext<QuestionTurn>({ open: false })

/** The Agent's questions in its reply: a quiet line each, the composer asks them. */
export function QuestionCards({ tools }: { readonly tools: readonly NormalizedTool[] }) {
  if (tools.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {tools.map((tool, index) => (
        // A reply's calls never reorder: their order is their identity.
        <QuestionLine key={index} tool={tool} />
      ))}
    </div>
  )
}

function QuestionLine({ tool }: { readonly tool: NormalizedTool }) {
  const turn = useContext(QuestionTurnContext)
  const messages = useAgentMessages().questions
  const questions = askedQuestions(tool.input)
  if (questions.length === 0) return null

  // While the reader may answer, the composer is the question: the reply leaves it to the composer.
  if (turn.open && turn.answering) return null
  const label = turn.open ? messages.waiting : messages.asked
  return (
    <div className="min-w-0">
      <p className={ACTIVITY_STATUS_ROW_CLASS_NAME}>
        <MessageCircleQuestion className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{label}</span>
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
