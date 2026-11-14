import { cn } from "@sixb/ui/lib/utils"
import { ArrowUp, Check, ChevronLeft, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAgentMessages } from "../i18n"
import { type AskedQuestion, answerText } from "./interpret"

export interface QuestionComposerProps {
  readonly questions: readonly AskedQuestion[]
  readonly onAnswer: (text: string) => void
  /** Back to the composer, to reply in words of one's own. */
  readonly onDismiss: () => void
  readonly className?: string
}

/**
 * The composer, become the Agent's question: the same surface in the same place, its questions one
 * at a time, each choice a row to pick and a last row to write something else. Picking the one
 * answer of the last question sends; several questions send together from the last.
 */
export function QuestionComposer({
  questions,
  onAnswer,
  onDismiss,
  className,
}: QuestionComposerProps) {
  const messages = useAgentMessages().questions
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<readonly (readonly string[])[]>(() =>
    questions.map(() => [])
  )
  const [other, setOther] = useState("")
  const [sent, setSent] = useState(false)
  const rows = useRef<HTMLDivElement>(null)

  const question = questions[step]
  const last = step === questions.length - 1
  const picked = answers[step] ?? []

  // Each question starts on its first choice, ready for the keyboard.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step moves the focus
  useEffect(() => {
    rows.current?.querySelector<HTMLButtonElement>("[data-choice]")?.focus({ preventScroll: true })
  }, [step])

  if (!question) return null

  const finish = (next: readonly (readonly string[])[]) => {
    const text = answerText(questions, next)
    if (!text || sent) return
    setSent(true)
    onAnswer(text)
  }

  const commit = (answer: readonly string[]) => {
    const next = answers.map((entry, index) => (index === step ? answer : entry))
    setAnswers(next)
    setOther("")
    if (last) finish(next)
    else setStep(step + 1)
  }

  const choose = (choice: string) => {
    if (!question.multiple) return commit([choice])
    setAnswers((current) =>
      current.map((entry, index) =>
        index !== step
          ? entry
          : entry.includes(choice)
            ? entry.filter((value) => value !== choice)
            : [...entry, choice]
      )
    )
  }

  const writeOther = () => {
    const text = other.trim()
    if (!text) return
    commit(question.multiple ? [...picked, text] : [text])
  }

  return (
    <div className={cn("relative bg-background px-4 pt-2 pb-3", className)}>
      <div className="mx-auto w-full max-w-[46rem]">
        <section
          aria-label={messages.card(questions.length)}
          aria-busy={sent}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              onDismiss()
              return
            }
            if (event.target instanceof HTMLInputElement) return
            const number = Number(event.key)
            const choice = Number.isInteger(number) ? question.choices[number - 1] : undefined
            if (choice !== undefined) {
              event.preventDefault()
              choose(choice)
              return
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              const all = [...(rows.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])]
              const at = all.indexOf(document.activeElement as HTMLElement)
              const to =
                event.key === "ArrowDown" ? Math.min(all.length - 1, at + 1) : Math.max(0, at - 1)
              all[to]?.focus()
            }
          }}
          className={cn(
            "sixb-composer-surface relative rounded-[26px] p-2",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-3 motion-safe:duration-300 motion-safe:ease-out"
          )}
        >
          {/* The question, where it stands among the others, and the way back to the composer. */}
          <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                aria-label={messages.back}
                className="-ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/[0.08]"
              >
                <ChevronLeft className="size-4" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h3
                key={step}
                className="text-[15px] leading-snug font-medium tracking-[-0.01em] text-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
              >
                {question.question}
              </h3>
              {question.multiple ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{messages.pickAny}</p>
              ) : null}
            </div>
            {questions.length > 1 ? (
              <span
                className="mt-1.5 flex shrink-0 items-center gap-1"
                aria-label={messages.step(step + 1, questions.length)}
              >
                {questions.map((entry, index) => (
                  <span
                    key={entry.question}
                    className={cn(
                      "size-1.5 rounded-full transition-colors duration-200",
                      index === step
                        ? "bg-foreground"
                        : index < step
                          ? "bg-foreground/40"
                          : "bg-foreground/15"
                    )}
                  />
                ))}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onDismiss}
              aria-label={messages.dismiss}
              title={messages.dismiss}
              className="-mt-0.5 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/[0.08]"
            >
              <X className="size-4" />
            </button>
          </div>

          <div
            ref={rows}
            key={step}
            className="flex flex-col gap-0.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
          >
            {question.choices.map((choice, index) => {
              const selected = picked.includes(choice)
              return (
                <button
                  key={choice}
                  type="button"
                  data-row=""
                  data-choice=""
                  aria-pressed={question.multiple ? selected : undefined}
                  disabled={sent}
                  onClick={() => choose(choice)}
                  className={cn(
                    "group/choice flex min-h-11 w-full items-center gap-3 rounded-[18px] px-3 text-left text-[15px] text-foreground outline-none transition-colors",
                    "hover:bg-black/[0.04] focus-visible:bg-black/[0.05] dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/[0.08]",
                    selected && "bg-black/[0.05] dark:bg-white/[0.08]"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-[7px] text-xs font-medium tabular-nums transition-colors",
                      selected
                        ? "bg-foreground text-background"
                        : "bg-black/[0.05] text-muted-foreground group-hover/choice:text-foreground dark:bg-white/[0.08]"
                    )}
                  >
                    {selected ? <Check className="size-3.5" strokeWidth={2.5} /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{choice}</span>
                </button>
              )
            })}

            {/* Something else, in words: the composer's own field and send button, in a row. */}
            <div
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-[18px] pr-1 pl-3",
                question.choices.length > 0 && "mt-0.5"
              )}
            >
              {question.choices.length > 0 ? (
                <span aria-hidden="true" className="size-6 shrink-0" />
              ) : null}
              <input
                data-row=""
                type="text"
                value={other}
                disabled={sent}
                aria-label={messages.typeAnswer}
                placeholder={
                  question.choices.length > 0 ? messages.somethingElse : messages.typeAnswer
                }
                onChange={(event) => setOther(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    if (other.trim()) writeOther()
                    else if (question.multiple && picked.length > 0) commit(picked)
                  }
                }}
                className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              {question.multiple || other.trim() || question.choices.length === 0 ? (
                <button
                  type="button"
                  disabled={sent || (!other.trim() && picked.length === 0)}
                  onClick={() => (other.trim() ? writeOther() : commit(picked))}
                  aria-label={last ? messages.send : messages.next}
                  className={cn(
                    "sixb-composer-send flex size-9 shrink-0 items-center justify-center rounded-full outline-none transition-colors",
                    "bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring/50",
                    "disabled:bg-foreground/25 dark:disabled:bg-white/20 dark:disabled:text-white/70"
                  )}
                >
                  <ArrowUp className={cn("size-4", !last && "rotate-90")} strokeWidth={2.25} />
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
