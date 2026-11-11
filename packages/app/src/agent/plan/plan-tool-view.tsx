import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { ChevronRight, ListChecks } from "lucide-react"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { planOf } from "./interpret"
import { PlanChecklist } from "./plan-checklist"

/** A `todo` call in the work: the plan as the call left it, `2 of 5 done`, opening to its items. */
export function PlanToolView({ tool }: { readonly tool: NormalizedTool }) {
  const messages = useAgentMessages().plan

  if (tool.state === "input-streaming" || tool.state === "input-available") {
    return (
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <ListChecks className="size-3.5 shrink-0" />
        <ActivityStatusText label={messages.updating} className="font-medium shimmer" />
      </div>
    )
  }

  const plan = tool.state === "output-available" ? planOf(tool.input) : null
  if (!plan) {
    return (
      <p className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <ListChecks className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">
          {tool.state === "output-error" ? messages.failed : messages.cleared}
        </span>
      </p>
    )
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
        <ListChecks className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{messages.updated}</span>
        <span className="min-w-0 shrink truncate text-muted-foreground/60">
          {messages.progress(plan.completed, plan.items.length)}
        </span>
        <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <PlanChecklist items={plan.items} className="mt-3 mb-1" />
      </CollapsibleContent>
    </Collapsible>
  )
}
