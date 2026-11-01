import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useState } from "react"
import { formatRelativeTime, formatTokenCount, relativeTime } from "../format"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import type { AgentThreadContext } from "../types"
import { ComposerMenu } from "./composer-menu"

/** From this share of its limit on, the meter takes a color: the conversation nears condensing. */
export const CONTEXT_METER_NEAR_SHARE = 0.8

export interface ContextMeterProps {
  /** The conversation's context against its model's limits; nothing shows without it. */
  readonly context?: AgentThreadContext
  /** The model the limits are measured for, as the picker names it. */
  readonly modelName?: string
  /** A compaction is under way. */
  readonly condensing?: boolean
}

/** How full the conversation is against its model's limit: quiet, nearing it, or past it. */
export type ContextMeterTone = "quiet" | "near" | "over"

/** What the meter draws from a conversation's context: how much of its limit it uses. */
export function contextMeterReading(context: AgentThreadContext) {
  const used = context.usedTokens ?? 0
  const share = used / context.limitTokens
  const tone: ContextMeterTone =
    share > 1 ? "over" : share >= CONTEXT_METER_NEAR_SHARE ? "near" : "quiet"
  const lastCall = context.lastCall
  const cacheShare =
    lastCall?.cacheReadInputTokens !== undefined && lastCall.inputTokens > 0
      ? lastCall.cacheReadInputTokens / lastCall.inputTokens
      : undefined

  return { used, share, tone, cacheShare }
}

/**
 * A ring beside the model that fills as the conversation nears the point where it is condensed,
 * colored only once it is close. It opens the details: how much of the model's limit is used, the
 * share read from cache and the last condensing. Nothing shows before the first answer.
 */
export function ContextMeter({ context, modelName, condensing = false }: ContextMeterProps) {
  const messages = useAgentMessages().contextMeter
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  if (!context || (context.usedTokens === undefined && !condensing)) return null

  const reading = contextMeterReading(context)
  const tokens = (value: number) => formatTokenCount(value, locale)
  const label = condensing
    ? messages.condensingLabel
    : messages.label(tokens(reading.used), tokens(context.limitTokens))

  return (
    <ComposerMenu
      open={open}
      onOpenChange={setOpen}
      title={messages.title}
      align="end"
      trigger={
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={label}
          data-tone={reading.tone}
          data-condensing={condensing || undefined}
          className={cn(
            "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/45 outline-none transition-colors",
            "hover:bg-black/[0.05] hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:bg-black/[0.05] dark:hover:bg-white/[0.08] dark:aria-expanded:bg-white/[0.08]",
            "data-[tone=near]:text-amber-600 data-[tone=over]:text-red-600 dark:data-[tone=near]:text-amber-400 dark:data-[tone=over]:text-red-400"
          )}
        >
          <ContextRing share={reading.share} condensing={condensing} />
        </button>
      }
    >
      <ContextDetails
        context={context}
        reading={reading}
        modelName={modelName ?? messages.thisModel}
        condensing={condensing}
        messages={messages}
      />
    </ComposerMenu>
  )
}

const RING_RADIUS = 7
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** The share filled clockwise from the top; a short arc turning while condensing. */
function ContextRing({
  share,
  condensing,
}: {
  readonly share: number
  readonly condensing: boolean
}) {
  const filled = condensing ? 0.25 : Math.min(1, Math.max(0, share))
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      className={cn("size-[18px] -rotate-90", condensing && "motion-safe:animate-spin")}
    >
      <circle
        cx="9"
        cy="9"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.25"
        className="stroke-current opacity-20"
      />
      <circle
        cx="9"
        cy="9"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        // A sliver stays visible from the first answer on.
        strokeDashoffset={RING_LENGTH * (1 - Math.max(filled, 0.04))}
        className="stroke-current transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  )
}

function ContextDetails({
  context,
  reading,
  modelName,
  condensing,
  messages,
}: {
  readonly context: AgentThreadContext
  readonly reading: ReturnType<typeof contextMeterReading>
  readonly modelName: string
  readonly condensing: boolean
  readonly messages: AgentMessages["contextMeter"]
}) {
  const agentMessages = useAgentMessages()
  const locale = useLocale()
  const tokens = (value: number) => formatTokenCount(value, locale)

  // "12m ago", "just now", or a date once it is a week old: `ago` reads only a relative time.
  const condensedWhen = (iso: string) => {
    const relative = relativeTime(new Date(iso).getTime(), agentMessages.time)
    if (relative === null) return formatRelativeTime(iso, locale, agentMessages.time)
    return relative === agentMessages.time.now ? messages.justNow : messages.ago(relative)
  }

  const compaction = context.lastCompaction
  const when = compaction ? condensedWhen(compaction.createdAt) : undefined

  return (
    <div data-context-details="" data-tone={reading.tone} className="group/context flex flex-col">
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11.5px] font-medium text-muted-foreground">{messages.title}</span>
          {condensing ? (
            <span className="shimmer text-xs text-muted-foreground">{messages.condensing}</span>
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round(reading.share * 100).toLocaleString(locale)}%
            </span>
          )}
        </div>
        <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] tabular-nums text-foreground">
          {tokens(reading.used)}
          <span className="text-[15px] font-medium text-muted-foreground">
            {" "}
            / {tokens(context.limitTokens)}
          </span>
        </p>
        <div
          role="meter"
          aria-label={messages.title}
          aria-valuemin={0}
          aria-valuemax={context.limitTokens}
          aria-valuenow={Math.min(reading.used, context.limitTokens)}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.1]"
        >
          <div
            className={cn(
              "h-full rounded-full bg-foreground/35 transition-[width] duration-500",
              "group-data-[tone=near]/context:bg-amber-500 group-data-[tone=over]/context:bg-red-500"
            )}
            style={{ width: `${Math.min(100, Math.max(2, reading.share * 100))}%` }}
          />
        </div>
        <p className="mt-2.5 text-xs leading-[1.45] text-muted-foreground">
          {messages.limit(modelName, tokens(context.limitTokens))}
        </p>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 border-t-[0.5px] border-black/[0.08] px-2.5 pt-2.5 pb-2 text-[12.5px] dark:border-white/[0.08]">
        {reading.cacheShare !== undefined ? (
          <DetailRow label={messages.cached}>
            {Math.round(reading.cacheShare * 100).toLocaleString(locale)}%
          </DetailRow>
        ) : null}
        {compaction && when !== undefined ? (
          <DetailRow label={messages.lastCondensed}>
            {when}
            {" · "}
            {tokens(compaction.estimatedInputTokensBefore)} →{" "}
            {tokens(compaction.estimatedInputTokensAfter)}
          </DetailRow>
        ) : null}
      </dl>
    </div>
  )
}

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground/85">{children}</dd>
    </>
  )
}
