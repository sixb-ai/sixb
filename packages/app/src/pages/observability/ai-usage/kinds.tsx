import { useLocale } from "@sixb/ui/lib/i18n"
import {
  ArrowDownWideNarrow,
  AudioLines,
  Binary,
  Captions,
  CircleDashed,
  Clapperboard,
  ImageIcon,
  type LucideIcon,
  MessagesSquare,
  Scale,
} from "lucide-react"
import { amountFor, formatCompact, formatDuration, nanosToNumber, type Overview } from "./format"
import { useAiUsageMessages } from "./messages"

export type ModelKind = NonNullable<Overview["kinds"][number]["modelKind"]>

const icons: Readonly<Record<ModelKind | "unclassified", LucideIcon>> = {
  language: MessagesSquare,
  embedding: Binary,
  decision: Scale,
  reranking: ArrowDownWideNarrow,
  image: ImageIcon,
  speech: AudioLines,
  transcription: Captions,
  video: Clapperboard,
  unclassified: CircleDashed,
}

/** The meters a call or a group of calls reported, as the page measures them. */
interface Measured {
  readonly totalTokens?: number
  readonly outputImages?: number
  readonly inputCharacters?: number
  readonly audioDurationMs?: number
}

/** Each kind in its own unit: tokens, images, characters, audio or searches. */
export function useUsageFormat() {
  const messages = useAiUsageMessages()
  const locale = useLocale()
  const number = (value: number) => value.toLocaleString(locale)
  const duration = (milliseconds: number) => formatDuration(milliseconds, messages.units, locale)
  return {
    /** Every meter the usage reported, one line each. */
    lines(usage: Measured, kind?: ModelKind): string[] {
      const lines = [
        usage.totalTokens === undefined
          ? undefined
          : messages.units.tokens(number(usage.totalTokens)),
        usage.outputImages === undefined
          ? undefined
          : messages.units.images(usage.outputImages, number(usage.outputImages)),
        usage.inputCharacters === undefined
          ? undefined
          : messages.units.characters(usage.inputCharacters, number(usage.inputCharacters)),
        usage.audioDurationMs === undefined
          ? undefined
          : messages.units.audio(duration(usage.audioDurationMs)),
      ].filter((line): line is string => line !== undefined)
      // A rerank reports nothing; it is one search.
      return lines.length === 0 && kind === "reranking" ? [messages.units.searches(1, "1")] : lines
    },
    /** The one figure that says what a kind produced over many calls, and its unit. */
    headline(
      kind: ModelKind | undefined,
      aggregate: Overview["totals"]
    ): { readonly value: string; readonly unit?: string } {
      const usage = aggregate.usage
      const counted = (count: number, phrase: (count: number, formatted: string) => string) => {
        const value = formatCompact(count, locale)
        const text = phrase(count, value)
        return text.startsWith(value)
          ? { value, unit: text.slice(value.length).trim() }
          : { value: text }
      }
      if (kind === "image" && usage.outputImages !== undefined) {
        return counted(usage.outputImages, messages.units.images)
      }
      if (kind === "speech" && usage.inputCharacters !== undefined) {
        return counted(usage.inputCharacters, messages.units.characters)
      }
      if (kind === "transcription" && usage.audioDurationMs !== undefined) {
        return { value: duration(usage.audioDurationMs) }
      }
      if (kind === "reranking") return counted(aggregate.modelCallCount, messages.units.searches)
      if (usage.totalTokens !== undefined) {
        return counted(usage.totalTokens, (_, formatted) => messages.units.tokens(formatted))
      }
      return counted(aggregate.modelCallCount, messages.kinds.calls)
    },
  }
}

/** A kind's icon and name beside a call that is not plain generation, with its price variant. */
export function KindLabel({
  kind,
  variant,
}: {
  readonly kind: ModelKind | undefined
  readonly variant?: string
}) {
  const names = useAiUsageMessages().kinds.names
  if (kind === undefined || kind === "language") return null
  const Icon = icons[kind]
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{variant ? `${names[kind]} · ${variant}` : names[kind]}</span>
    </span>
  )
}

export interface KindBreakdownRow {
  readonly key: string
  readonly label: string
  readonly icon: LucideIcon
  /** What the kind produced, such as "58 images". */
  readonly detail: string
  readonly value: number
}

/**
 * Cost by kind, for the breakdown card: each kind with what it produced in its own unit. Calls
 * recorded before kinds were kept come last, whatever they cost.
 */
export function useKindBreakdown(
  overview: Overview,
  currency: string | undefined
): readonly KindBreakdownRow[] {
  const names = useAiUsageMessages().kinds.names
  const usage = useUsageFormat()
  return overview.kinds
    .flatMap((kind) => {
      const cost = amountFor(kind.costs.amounts, currency)
      if (!cost) return []
      const key = kind.modelKind ?? "unclassified"
      const headline = usage.headline(kind.modelKind, kind)
      return [
        {
          key,
          label: names[key],
          icon: icons[key],
          detail: headline.unit ? `${headline.value} ${headline.unit}` : headline.value,
          value: nanosToNumber(cost.amountNanos),
          unclassified: kind.modelKind === undefined,
        },
      ]
    })
    .sort(
      (left, right) =>
        Number(left.unclassified) - Number(right.unclassified) || right.value - left.value
    )
    .map(({ unclassified: _, ...row }) => row)
}
