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

/** A part of the context, as the API names it. */
export type ContextPartName = NonNullable<AgentThreadContext["parts"]>[number]["part"]

/**
 * What the meter draws from a conversation's context: how much of its limit it uses, and how the
 * model's window divides: what each part uses, the room left before the limit, and the room kept
 * for the answer. The three add up to the window.
 */
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

  // A conversation past its limit takes room from the answer's: the bar then spans what it uses.
  const reservedTokens = Math.max(0, context.windowTokens - context.limitTokens)
  const freeTokens = Math.max(0, context.limitTokens - used)
  const parts = (context.parts ?? []).map(({ part, tokens }) => ({
    part,
    tokens,
    share: used > 0 ? tokens / used : 0,
  }))

  return { used, share, tone, cacheShare, parts, freeTokens, reservedTokens }
}

/**
 * Each part's color in the bar and beside its name: the prompt in blues, memory and the ontology
 * in violets with skills in magenta between them (checked apart for color-blind readers, in both
 * themes), the tools in teals, the conversation in the text's own grey, files in sand. Amber and
 * red stay the meter's own, for a conversation near or past its limit.
 */
const PART_COLORS: Readonly<Record<ContextPartName, string>> = {
  system: "bg-[#2a78d6] dark:bg-[#3987e5]",
  instructions: "bg-[#86b6ef] dark:bg-[#1c5cab]",
  memory: "bg-[#6250d6] dark:bg-[#9085e9]",
  skills: "bg-[#d55181] dark:bg-[#d55181]",
  ontology: "bg-[#9e93ec] dark:bg-[#6250d6]",
  tools: "bg-[#1baf7a] dark:bg-[#199e70]",
  summary: "bg-foreground/30",
  messages: "bg-foreground/60",
  toolResults: "bg-[#0f7d57] dark:bg-[#5fd0a5]",
  files: "bg-[#a07850] dark:bg-[#c49a6c]",
}

/**
 * A ring beside the model that fills as the conversation nears the point where it is condensed,
 * colored only once it is close. It opens the details: what each part of the
 * conversation uses, the room left, the share read from cache and the last condensing. Nothing
 * shows before the first answer.
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
      className="sixb-composer-solid w-[21.5rem]"
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
            "group/meter mb-0.5 flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-foreground/70 outline-none transition-colors",
            "hover:bg-black/[0.05] hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:bg-black/[0.05] dark:hover:bg-white/[0.08] dark:aria-expanded:bg-white/[0.08]",
            "data-[tone=near]:text-amber-600 data-[tone=over]:text-red-600 dark:data-[tone=near]:text-amber-400 dark:data-[tone=over]:text-red-400"
          )}
        >
          <ContextRing share={reading.share} condensing={condensing} />
          {/* The share in figures: a ring alone, nearly empty, reads as a loading spinner. */}
          <span
            aria-hidden="true"
            className={cn(
              "text-[12.5px] font-medium tabular-nums text-muted-foreground",
              "group-data-[tone=near]/meter:text-amber-700 group-data-[tone=over]/meter:text-red-600",
              "dark:group-data-[tone=near]/meter:text-amber-400 dark:group-data-[tone=over]/meter:text-red-400"
            )}
          >
            {sharePercent(reading.share, locale)}
          </span>
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

/** A share as the meter writes it: `2%`, `<1%` for a sliver, `104%` past the limit. */
function sharePercent(share: number, locale: string): string {
  if (share > 0 && share < 0.01) return "<1%"
  return `${Math.round(share * 100).toLocaleString(locale)}%`
}

/** The least of the ring a conversation fills, so a small one still reads as a reading. */
const RING_MIN_SHARE = 0.08

const RING_RADIUS = 7
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * A progress ring: a full track, never hidden, and an arc from twelve o'clock clockwise. The track
 * is what tells it from a spinner, and it never turns: while the conversation is condensed, the
 * arc breathes.
 */
function ContextRing({
  share,
  condensing,
}: {
  readonly share: number
  readonly condensing: boolean
}) {
  const filled = Math.min(1, Math.max(RING_MIN_SHARE, share))
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="size-[18px] shrink-0">
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        className="stroke-black/[0.13] dark:stroke-white/[0.18]"
      />
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - filled)}
        transform="rotate(-90 10 10)"
        className={cn(
          "stroke-current transition-[stroke-dashoffset] duration-500",
          condensing && "motion-safe:animate-pulse"
        )}
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
  const percent = (share: number) => sharePercent(share, locale)

  // "12m ago", "just now", or a date once it is a week old: `ago` reads only a relative time.
  const condensedWhen = (iso: string) => {
    const relative = relativeTime(new Date(iso).getTime(), agentMessages.time)
    if (relative === null) return formatRelativeTime(iso, locale, agentMessages.time)
    return relative === agentMessages.time.now ? messages.justNow : messages.ago(relative)
  }

  const compaction = context.lastCompaction
  const when = compaction ? condensedWhen(compaction.createdAt) : undefined
  const status =
    reading.tone === "over"
      ? messages.over
      : reading.tone === "near"
        ? messages.near
        : messages.limit(tokens(context.limitTokens))

  return (
    <div data-context-details="" data-tone={reading.tone} className="group/context flex flex-col">
      <div className="px-2.5 pt-2 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11.5px] font-medium text-muted-foreground">{messages.title}</span>
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{modelName}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <p className="text-[22px] font-semibold tracking-[-0.02em] tabular-nums text-foreground">
            {tokens(reading.used)}
            <span className="text-[15px] font-medium text-muted-foreground">
              {" "}
              / {tokens(context.limitTokens)}
            </span>
          </p>
          {condensing ? (
            <span className="shimmer text-xs text-muted-foreground">{messages.condensing}</span>
          ) : (
            <span
              className={cn(
                "text-[13px] font-medium tabular-nums text-muted-foreground",
                "group-data-[tone=near]/context:text-amber-700 group-data-[tone=over]/context:text-red-600",
                "dark:group-data-[tone=near]/context:text-amber-400 dark:group-data-[tone=over]/context:text-red-400"
              )}
            >
              {percent(reading.share)}
            </span>
          )}
        </div>
        <ContextBar context={context} reading={reading} messages={messages} />
        <p
          className={cn(
            "mt-2.5 text-xs leading-[1.45] text-muted-foreground",
            "group-data-[tone=near]/context:text-amber-700 group-data-[tone=over]/context:text-red-600",
            "dark:group-data-[tone=near]/context:text-amber-400 dark:group-data-[tone=over]/context:text-red-400"
          )}
        >
          {status}
        </p>
      </div>

      {reading.parts.length > 0 ? (
        <ul
          aria-label={messages.breakdown}
          className="flex flex-col gap-[3px] border-t-[0.5px] border-black/[0.08] px-2.5 pt-2.5 pb-2 text-[12.5px] dark:border-white/[0.08]"
        >
          {reading.parts.map(({ part, tokens: partTokens, share }) => (
            <LegendRow
              key={part}
              swatch={PART_COLORS[part]}
              label={messages.parts[part]}
              value={tokens(partTokens)}
              share={percent(share)}
            />
          ))}
          <LegendRow
            swatch="bg-black/[0.07] ring-1 ring-inset ring-black/[0.08] dark:bg-white/[0.08] dark:ring-white/[0.1]"
            label={messages.free}
            value={tokens(reading.freeTokens)}
            muted
          />
          <LegendRow
            swatch="context-meter-hatch ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1]"
            label={messages.reserved}
            value={tokens(reading.reservedTokens)}
            muted
          />
        </ul>
      ) : null}

      {reading.cacheShare !== undefined || (compaction && when !== undefined) ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 border-t-[0.5px] border-black/[0.08] px-2.5 pt-2.5 pb-2 text-[12.5px] dark:border-white/[0.08]">
          {compaction && when !== undefined ? (
            <DetailRow label={messages.lastCondensed}>
              {when}
              {" · "}
              {tokens(compaction.estimatedInputTokensBefore)} →{" "}
              {tokens(compaction.estimatedInputTokensAfter)}
            </DetailRow>
          ) : null}
          {reading.cacheShare !== undefined ? (
            <DetailRow label={messages.cached}>{percent(reading.cacheShare)}</DetailRow>
          ) : null}
        </dl>
      ) : null}
    </div>
  )
}

/**
 * The model's window in one bar: each part of what the conversation uses, the room left before
 * the limit, then the room kept for the answer, hatched.
 */
function ContextBar({
  context,
  reading,
  messages,
}: {
  readonly context: AgentThreadContext
  readonly reading: ReturnType<typeof contextMeterReading>
  readonly messages: AgentMessages["contextMeter"]
}) {
  const span = Math.max(context.windowTokens, reading.used + reading.reservedTokens)
  const share = (value: number) => (value / span) * 100
  const parts =
    reading.parts.length > 0
      ? reading.parts
      : [{ part: "messages" as const, tokens: reading.used, share: 1 }]
  // Parts too thin to tell apart in a short run read as one stripe, without gaps or slivers.
  const compact = share(reading.used) < 15

  return (
    <div
      role="meter"
      aria-label={messages.title}
      aria-valuemin={0}
      aria-valuemax={context.limitTokens}
      aria-valuenow={Math.min(reading.used, context.limitTokens)}
      aria-valuetext={messages.label(
        formatTokenCount(reading.used),
        formatTokenCount(context.limitTokens)
      )}
      className="mt-2.5 flex h-2 gap-[2px] overflow-hidden rounded-full"
    >
      <div
        className={cn("flex h-full shrink-0", compact ? "min-w-1" : "gap-[2px]")}
        style={{ width: `${share(reading.used)}%` }}
      >
        {parts.map(({ part, tokens }) => (
          <div
            key={part}
            className={cn(
              "h-full transition-[width] duration-500",
              compact ? "shrink" : "min-w-[3px] shrink-0",
              PART_COLORS[part]
            )}
            style={{ width: `${(tokens / Math.max(1, reading.used)) * 100}%` }}
          />
        ))}
      </div>
      {reading.freeTokens > 0 ? (
        <div className="h-full min-w-0 flex-1 bg-black/[0.07] dark:bg-white/[0.09]" />
      ) : null}
      <div
        className="context-meter-hatch h-full shrink-0"
        style={{ width: `${share(reading.reservedTokens)}%` }}
      />
    </div>
  )
}

function LegendRow({
  swatch,
  label,
  value,
  share,
  muted = false,
}: {
  readonly swatch: string
  readonly label: string
  readonly value: string
  readonly share?: string
  readonly muted?: boolean
}) {
  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)_auto_2.75rem] items-center gap-x-2 leading-5">
      <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", swatch)} />
      <span className={cn("truncate", muted ? "text-muted-foreground" : "text-foreground/85")}>
        {label}
      </span>
      <span
        className={cn(
          "text-right tabular-nums",
          muted ? "text-muted-foreground" : "text-foreground/85"
        )}
      >
        {value}
      </span>
      <span className="text-right tabular-nums text-muted-foreground">{share ?? ""}</span>
    </li>
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
