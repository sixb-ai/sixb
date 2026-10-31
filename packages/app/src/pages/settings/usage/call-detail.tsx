import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowUpRight, Copy } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"
import { threadPath } from "../../../agent/thread-navigation"
import { actionRunHref, workflowRunHref } from "../../routes"
import { useAiUsageMessages } from "./messages"
import { type Call, compact, fineMoney, type Group } from "./spend-model"

type Component = Extract<NonNullable<Call["cost"]>, { status: "rated" }>["components"][number]
type Part = "cacheRead" | "cacheWrite" | "input" | "output" | "other"

const partOf = (meter: Component["meter"]): Part =>
  meter === "tokens.input.cacheRead"
    ? "cacheRead"
    : meter.startsWith("tokens.input.cacheWrite")
      ? "cacheWrite"
      : meter.startsWith("tokens.input")
        ? "input"
        : meter.startsWith("tokens.output")
          ? "output"
          : "other"

// A gray ramp from cheap to dear: cached reads lightest, output darkest.
const partColors: Record<Part, string> = {
  cacheRead: "bg-foreground/15",
  cacheWrite: "bg-foreground/35",
  input: "bg-foreground/65",
  output: "bg-foreground",
  other: "bg-foreground/50",
}
const partOrder: readonly Part[] = ["cacheRead", "cacheWrite", "input", "output", "other"]

/** How one call was priced, opened under its row in the conversations and runs. */
export function CallDetail({
  call,
  group,
  depth,
  currency: pageCurrency,
}: {
  readonly call: Call
  readonly group: Group
  readonly depth: number
  readonly currency: string
}) {
  const messages = useAiUsageMessages().call
  const locale = useLocale()
  const [copied, setCopied] = useState(false)
  const cost = call.cost
  const priced = cost?.status === "rated" ? cost : undefined
  const components = priced?.components.length
    ? priced.components
    : cost?.estimate?.status === "rated"
      ? cost.estimate.components
      : []
  const currency = priced?.money.currency ?? pageCurrency
  const nanos = (value: number) => fineMoney(value / 1e9, currency, locale)
  // A meter the call used none of, such as an embedding's output, says nothing.
  const sorted = components
    .filter((component) => component.quantity !== "0")
    .sort((a, b) => partOrder.indexOf(partOf(a.meter)) - partOrder.indexOf(partOf(b.meter)))
  const bar = (measure: (component: Component) => number) =>
    partOrder
      .map((part) => ({
        part,
        weight: sorted
          .filter((component) => partOf(component.meter) === part)
          .reduce((total, component) => total + measure(component), 0),
      }))
      .filter((entry) => entry.weight > 0)
  const tokens = bar((component) =>
    component.meter.startsWith("tokens.") ? Number(component.quantity) : 0
  )
  const charges = bar((component) => Number(component.chargeAmountNanos))
  const cacheRead = components.find((component) => component.meter === "tokens.input.cacheRead")
  const fresh =
    components.find((component) => component.meter === "tokens.input.uncached") ??
    components.find((component) => component.meter === "tokens.input.total")
  const savings =
    cacheRead && fresh
      ? {
          saved:
            (Number(cacheRead.quantity) *
              (Number(fresh.rateAmountNanosPerMillion) -
                Number(cacheRead.rateAmountNanosPerMillion))) /
            1e6,
          full: (Number(cacheRead.quantity) * Number(fresh.rateAmountNanosPerMillion)) / 1e6,
          tokens: compact(Number(cacheRead.quantity), locale),
        }
      : undefined
  const reasoning = call.usage.requestedReasoning
  const href = groupHref(group)
  const ids = [
    `call ${call.usage.callId}`,
    call.usage.providerIds?.requestId ? `request ${call.usage.providerIds.requestId}` : undefined,
    `response ${call.usage.responseId}`,
    `execution ${call.usage.executionId}`,
  ].filter(Boolean)

  return (
    <div
      className="bg-muted/40 pt-1 pr-5 pb-5"
      // Under the call's name, so the detail reads as the row opened.
      style={{ paddingLeft: depth * 26 + 20 + 74 }}
    >
      <div className="grid gap-x-10 gap-y-6 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {components.length > 0 ? (
            <>
              <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
                <span>{messages.tokens}</span>
                <PartBar parts={tokens} />
                <span>{messages.cost}</span>
                <PartBar parts={charges} />
              </div>
              <div>
                <div className={cn(meterRow, "border-t-0 pt-0 text-xs text-muted-foreground")}>
                  <span>{messages.meter}</span>
                  <span className="text-right">{messages.quantity}</span>
                  <span className="text-right">{messages.rate}</span>
                  <span className="text-right">{messages.charge}</span>
                </div>
                {sorted.map((component) => (
                  <div key={`${component.meter}:${component.variant ?? ""}`} className={meterRow}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn("size-2 rounded-[3px]", partColors[partOf(component.meter)])}
                      />
                      {messages.meters[component.meter]}
                      {partOf(component.meter) === "output" &&
                      call.usage.usage.reasoningOutputTokens ? (
                        <span className="text-xs text-muted-foreground/80">
                          {compact(call.usage.usage.reasoningOutputTokens, locale)}{" "}
                          {messages.meters["tokens.output.reasoning"].toLowerCase()}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-right text-foreground/80 tabular-nums">
                      {Number(component.quantity).toLocaleString(locale)}
                    </span>
                    <span className="text-right text-foreground/80 tabular-nums">
                      {new Intl.NumberFormat(locale, {
                        style: "currency",
                        currency,
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 3,
                      }).format(Number(component.rateAmountNanosPerMillion) / 1e9)}
                    </span>
                    <span className="text-right tabular-nums">
                      {nanos(Number(component.chargeAmountNanos))}
                    </span>
                  </div>
                ))}
                <div className={cn(meterRow, "font-semibold")}>
                  <span>{messages.total}</span>
                  <span className="text-right tabular-nums">
                    {call.usage.usage.totalTokens?.toLocaleString(locale) ?? ""}
                  </span>
                  <span />
                  <span className="text-right tabular-nums">
                    {priced ? nanos(Number(priced.money.amountNanos)) : "—"}
                  </span>
                </div>
              </div>
              {savings && savings.saved > 0 ? (
                <div className="text-[0.8125rem] text-muted-foreground">
                  {messages.saved(nanos(savings.saved), savings.tokens, nanos(savings.full))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-[0.8125rem] text-muted-foreground">
              {priced ? messages.reported : messages.unpriced}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="m-0 grid grid-cols-[128px_minmax(0,1fr)] gap-x-3 gap-y-[9px] text-[0.8125rem] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:truncate [&_dt]:text-muted-foreground">
            <dt>{messages.details.requested}</dt>
            <dd className="font-mono text-xs">{call.usage.requestedModelId}</dd>
            <dt>{messages.details.answeredBy}</dt>
            <dd className="font-mono text-xs">{call.usage.responseModelId ?? "—"}</dd>
            <dt>{messages.details.provider}</dt>
            <dd>{call.usage.providerId}</dd>
            <dt>{messages.details.reasoning}</dt>
            <dd>
              {reasoning === undefined
                ? "—"
                : typeof reasoning === "string"
                  ? reasoning
                  : compact(reasoning.budgetTokens, locale)}
            </dd>
            <dt>{messages.details.attempt}</dt>
            <dd>{call.usage.attempt}</dd>
            {priced?.pricingContext.serviceTier ? (
              <>
                <dt>{messages.details.tier}</dt>
                <dd>{priced.pricingContext.serviceTier}</dd>
              </>
            ) : null}
            <dt>{messages.details.priceList}</dt>
            <dd>
              {!priced
                ? "—"
                : priced.source === "provider"
                  ? messages.reported
                  : `${priced.priceSource.sourceId} · ${new Date(priced.priceSource.observedAt).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}`}
            </dd>
            <dt>{messages.details.started}</dt>
            <dd className="tabular-nums">
              {new Date(call.usage.occurredAt).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </dd>
            <dt>{messages.details.requestId}</dt>
            <dd className="font-mono text-xs">{call.usage.providerIds?.requestId ?? "—"}</dd>
            <dt>{messages.details.callId}</dt>
            <dd className="font-mono text-xs">{call.usage.callId}</dd>
          </dl>
          <div className="mt-auto flex flex-wrap gap-2">
            {href ? (
              <Button asChild variant="outline" size="sm">
                <Link to={href}>
                  <ArrowUpRight />
                  {group.attribution?.kind === "agent"
                    ? messages.openConversation
                    : messages.openRun}
                </Link>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(ids.join("\n")).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                })
              }}
            >
              <Copy />
              {copied ? messages.copied : messages.copyIds}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const meterRow =
  "grid grid-cols-[minmax(0,1fr)_84px_84px_84px] items-center gap-2.5 border-t border-border/50 py-[7px] text-[0.8125rem]"

function PartBar({ parts }: { readonly parts: readonly { part: Part; weight: number }[] }) {
  return (
    <span className="flex h-2.5 gap-0.5">
      {parts.map((entry) => (
        <span
          key={entry.part}
          className={cn("block h-full min-w-[3px] rounded-[2px]", partColors[entry.part])}
          style={{ flex: `${entry.weight} 1 0` }}
        />
      ))}
    </span>
  )
}

function groupHref(group: Group): string | undefined {
  const source = group.attribution
  if (source?.kind === "agent") return group.canOpenThread ? threadPath(source.threadId) : undefined
  if (source?.kind === "workflowAgent" || source?.kind === "workflow") {
    return workflowRunHref(source.workflowRunId)
  }
  if (source?.kind === "action") return actionRunHref(source.actionRunId)
  return undefined
}
