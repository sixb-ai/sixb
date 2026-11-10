import { Bubble, BubbleContent } from "@sixb/ui/components"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { askedQuestions } from "../questions/interpret"

/**
 * What the Agent sent a sub-agent, in the sub-agent's panel: its answer or its message, on the
 * other side of the conversation, as a person's message reads in the Agent's own.
 */
export function AgentNote({ text }: { readonly text: string }) {
  return (
    <Bubble variant="secondary" align="end" data-agent-note="">
      <BubbleContent className="rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-wrap">
        {text}
      </BubbleContent>
    </Bubble>
  )
}

/**
 * A sub-agent's question to the Agent, in its panel: what it asked, as its own words, then the
 * Agent's answer when it came in the same run. One that came later opens the next run instead.
 */
export function ChildAsked({ tool }: { readonly tool: NormalizedTool }) {
  const labels = useAgentMessages().delegation
  const questions = askedQuestions(tool.input)
  if (questions.length === 0) return null
  const output = isRecord(tool.output) ? tool.output : {}
  const answer = typeof output.answer === "string" ? output.answer : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 text-[15px] leading-relaxed text-foreground">
        {questions.map((question) => (
          <div key={question.question}>
            <p className="break-words">{question.question}</p>
            {question.choices.length > 0 ? (
              <p className="text-[13px] text-muted-foreground">{question.choices.join(" · ")}</p>
            ) : null}
          </div>
        ))}
      </div>
      {answer !== null ? <AgentNote text={answer} /> : null}
      {output.status === "unanswered" ? (
        <p className="text-[13px] text-muted-foreground">{labels.noAnswer}</p>
      ) : null}
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
