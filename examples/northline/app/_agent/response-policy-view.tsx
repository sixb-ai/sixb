import { defineAgentToolView } from "@sixb/app"
import { Skeleton } from "@sixb/ui/components"
import { Clock, ShieldCheck, Truck } from "lucide-react"
import type { ReactNode } from "react"
import type { lookupResponsePolicy } from "../../ai/tools"
import { humanize, StatusBadge } from "../_components/ui"

/** The response policy the assistant looked up, as a card below its answer. */
export const responsePolicyView = defineAgentToolView<typeof lookupResponsePolicy>(
  "lookup_response_policy",
  { placement: "answer" }
).render(({ state, input, output }) => {
  if (state === "output-error") return null

  if (state !== "output-available") {
    return (
      <PolicyCard
        tier={input?.contractTier}
        badge={<Skeleton className="h-5 w-16 rounded-full" />}
        aria-busy
      >
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-9 rounded-lg" />
      </PolicyCard>
    )
  }

  return (
    <PolicyCard tier={output.contractTier} badge={<StatusBadge value={output.alarmSeverity} />}>
      <Fact icon={<Clock className="size-3.5" />} label="Respond within">
        {formatWindow(output.responseWindowMinutes)}
      </Fact>
      <Fact icon={<Truck className="size-3.5" />} label="Dispatch">
        {output.dispatchRecommended ? "Recommended" : "Not needed"}
      </Fact>
    </PolicyCard>
  )
})

function PolicyCard({
  tier,
  badge,
  children,
  ...props
}: {
  readonly tier: string | undefined
  readonly badge: ReactNode
  readonly children: ReactNode
  readonly "aria-busy"?: boolean
}) {
  return (
    <section
      aria-label="Response policy"
      className="@container flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-3 text-card-foreground"
      {...props}
    >
      <header className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Response policy</p>
          <p className="truncate text-xs text-muted-foreground">
            {tier ? `${humanize(tier)} contract` : "Contract tier"}
          </p>
        </div>
        {badge}
      </header>
      <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">{children}</div>
    </section>
  )
}

function Fact({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <dl className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="ml-auto truncate text-sm font-medium tabular-nums">{children}</dd>
    </dl>
  )
}

function formatWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} min`

  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`
}
