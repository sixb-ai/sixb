import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronUp } from "lucide-react"
import { useState } from "react"
import type { TranscriptApprovals } from "../approvals"
import type { AgentConversationMessage, AgentConversationTurn } from "../conversation"
import { useAgentMessages } from "../i18n"
import { livePlan, type Plan } from "./interpret"
import { PlanChecklist, PlanProgressRing } from "./plan-checklist"

export interface AgentPlanProps {
  /** The conversation, as `useAgentConversation` merges it. */
  readonly messages: readonly AgentConversationMessage[]
  /** The newest turn: the plan shows while it answers. */
  readonly turn: AgentConversationTurn
  /** The thread's held calls: the plan stays while the turn waits for a decision on one. */
  readonly approvals?: TranscriptApprovals | null
  readonly className?: string
}

/**
 * The Agent's plan over the composer while a turn works on it, or waits for a decision on a call:
 * one line with what it does now and how far it is, which opens to every item. Nothing once the
 * turn ends, as its answer says how it went, or while the turn has no plan. The reply's work line goes on saying its newest step, so
 * the item in progress reads here only, beside what the Agent does for it.
 */
export function AgentPlan({ messages, turn, approvals, className }: AgentPlanProps) {
  const plan = livePlan(messages, turn, approvals?.approvals)
  if (!plan) return null

  return <PlanStrip plan={plan} className={className} />
}

function PlanStrip({ plan, className }: { readonly plan: Plan; readonly className?: string }) {
  const messages = useAgentMessages().plan
  const [open, setOpen] = useState(false)
  const progress = messages.progress(plan.completed, plan.items.length)

  return (
    <section aria-label={messages.label} className={cn("bg-background px-4 pt-2", className)}>
      <div className="mx-auto w-full max-w-[46rem] px-2.5">
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className={cn(
            // The list opens above the line, so the line stays where it was clicked.
            "sixb-composer-surface flex flex-col-reverse rounded-[20px]",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
          )}
        >
          <CollapsibleTrigger
            className={cn(
              "group flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[20px] px-3.5 text-left text-[13px] outline-none pointer-coarse:h-11",
              "focus-visible:ring-2 focus-visible:ring-ring/40"
            )}
          >
            <PlanProgressRing
              completed={plan.completed}
              total={plan.items.length}
              className="text-foreground/80"
            />
            {/* Open, the list says each item: the line names the plan. */}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                plan.current || open ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {open ? messages.label : (plan.current ?? messages.label)}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{progress}</span>
            <ChevronUp
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0">
            <div className="scrollbar-thin max-h-[min(40vh,20rem)] overflow-y-auto overscroll-contain border-b border-border/60 px-3.5 pt-3 pb-3">
              <PlanChecklist items={plan.items} live />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  )
}
