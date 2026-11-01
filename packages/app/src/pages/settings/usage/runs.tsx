import { listAiModelCallGroupsOptions, listAiModelCallsOptions } from "@sixb/client/hooks"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  Bot,
  ChevronRight,
  Ellipsis,
  type LucideIcon,
  MessageSquare,
  SquareTerminal,
  User,
  Workflow,
  Zap,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { PanelSkeleton } from "../../section-ui"
import { CallDetail } from "./call-detail"
import { useNames } from "./filter-menu"
import { useAiUsageMessages } from "./messages"
import { Segmented } from "./segmented"
import {
  activeRange,
  apiFilters,
  cachedShare,
  colorOf,
  compact,
  costOf,
  fineMoney,
  type Group,
  type GroupExecution,
  modelKey,
  percent,
  type SpendFilters,
  type SpendRange,
  whenLabel,
} from "./spend-model"

type RunType = "all" | "agent" | "workflow" | "action"
type Sort = "recent" | "cost"

const pageSize = 25
// The server lists at most this many in one page.
const largestPage = 200
// A conversation opens on its latest turns; the earlier ones are one click away.
const latestTurns = 5

const gridRow =
  "grid grid-cols-[minmax(280px,1fr)_168px_52px_72px_60px_84px_84px] items-center gap-3.5 px-5"

interface Context {
  readonly range: { readonly from: string; readonly to: string }
  readonly filters: SpendFilters
  readonly currency: string
  readonly palette: ReadonlyMap<string, string>
}

/** The source the list asks for: the Show choice, unless a filter already names one. */
function sourceFor(type: RunType, filters: SpendFilters): string | null | undefined {
  if (type === "all") return filters.source
  if (!filters.source) return type
  const same =
    filters.source === type || (type === "workflow" && filters.source.startsWith("workflow:"))
  // The two disagree, so nothing can match.
  return same ? filters.source : null
}

/** How many conversations and runs the filters keep, for the page's headline. */
export function useRunsTotal(
  query: {
    readonly from: string
    readonly to: string
  } & ReturnType<typeof apiFilters>
): number | undefined {
  const { data } = useQuery({
    ...listAiModelCallGroupsOptions({ query: { ...query, limit: "1" } }),
    retry: false,
  })
  return data?.total
}

/**
 * Every conversation, workflow run and action run that called a model, opening onto its turns
 * or steps and each call, down to how the call was priced.
 */
export function Runs({
  range,
  filters,
  currency,
  palette,
}: {
  readonly range: SpendRange
  readonly filters: SpendFilters
  readonly currency: string
  readonly palette: ReadonlyMap<string, string>
}) {
  const messages = useAiUsageMessages().runs
  const locale = useLocale()
  const [type, setType] = useState<RunType>("all")
  const [sort, setSort] = useState<Sort>("recent")
  const [limit, setLimit] = useState(pageSize)
  const active = activeRange(range, filters)
  const source = sourceFor(type, filters)
  const groups = useQuery({
    ...listAiModelCallGroupsOptions({
      query: {
        ...active,
        ...apiFilters(filters),
        ...(source ? { source } : {}),
        ...(filters.price ? { valuationStatus: filters.price } : {}),
        sort,
        limit: String(limit),
      },
    }),
    enabled: source !== null,
    retry: false,
  })
  const context: Context = { range: active, filters, currency, palette }
  const items = source === null ? [] : (groups.data?.items ?? [])
  const total = source === null ? 0 : (groups.data?.total ?? 0)

  return (
    <section
      id="usage-runs"
      className="overflow-hidden rounded-2xl border border-border/80 bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3.5">
        <div className="max-w-[560px]">
          <h2 className="text-[0.9375rem] font-semibold">{messages.title}</h2>
          <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {messages.description}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label={messages.title}
            value={type}
            options={(["all", "agent", "workflow", "action"] as const).map((value) => ({
              value,
              label: messages.types[value],
            }))}
            onChange={(value) => {
              setType(value)
              setLimit(pageSize)
            }}
          />
          <Segmented
            label={messages.sorts.recent}
            value={sort}
            options={(["recent", "cost"] as const).map((value) => ({
              value,
              label: messages.sorts[value],
            }))}
            onChange={setSort}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <div className={cn(gridRow, "min-h-9 text-xs font-medium text-muted-foreground")}>
            <span>{messages.columns.what}</span>
            <span>{messages.columns.models}</span>
            <span className="text-right">{messages.columns.calls}</span>
            <span className="text-right">{messages.columns.tokens}</span>
            <span className="text-right">{useAiUsageMessages().breakdown.columns.cached}</span>
            <span className="text-right">{messages.columns.cost}</span>
            <span className="text-right">{messages.columns.when}</span>
          </div>
          {groups.isPending && source !== null ? (
            <PanelSkeleton rows={5} />
          ) : groups.isError ? (
            <Notice>{messages.failed}</Notice>
          ) : items.length === 0 ? (
            <Notice>{messages.empty}</Notice>
          ) : (
            items.map((group) => (
              <GroupRow key={group.executionId} group={group} context={context} />
            ))
          )}
          {items.length > 0 ? (
            <div className="flex items-center justify-between border-t border-border/50 px-5 py-3.5 text-[0.8125rem] text-muted-foreground">
              <span className="tabular-nums">
                {messages.count(items.length.toLocaleString(locale), total.toLocaleString(locale))}
              </span>
              {items.length < total && limit < largestPage ? (
                <button
                  type="button"
                  className="font-medium text-foreground hover:underline hover:underline-offset-4"
                  onClick={() => setLimit((value) => Math.min(largestPage, value + pageSize))}
                >
                  {messages.showMore(Math.min(pageSize, total - items.length))}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border-t border-border/50 px-5 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

// ── Rows ──────────────────────────────────────────────────────────────

interface Measured {
  readonly modelCallCount: number
  readonly totalTokens?: number
  readonly inputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly costs: Group["costs"]
}

interface RowProps {
  readonly depth: number
  readonly icon?: LucideIcon
  readonly swatch?: string
  readonly top?: boolean
  readonly title: string
  readonly text?: string
  readonly quote?: boolean
  readonly models?: readonly GroupExecution["models"][number][]
  readonly measured?: Measured
  readonly cost?: string
  readonly at?: string
  readonly expandable?: boolean
  readonly open?: boolean
  readonly selected?: boolean
  readonly muted?: boolean
  readonly onClick?: () => void
  readonly context: Context
}

function TreeRow({
  depth,
  icon: Icon,
  swatch,
  top,
  title,
  text,
  quote,
  models,
  measured,
  cost,
  at,
  expandable,
  open,
  selected,
  muted,
  onClick,
  context,
}: RowProps) {
  const locale = useLocale()
  const mix = models ? modelMix(models, context) : []
  const leading = mix[0]
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expandable ? open : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault()
          onClick()
        }
      }}
      className={cn(
        gridRow,
        "cursor-pointer border-t hover:bg-muted/40",
        top ? "min-h-[60px] border-border/70" : "min-h-11 border-border/40",
        top && open && "bg-muted/40",
        selected && "bg-muted/40 hover:bg-muted/40",
        muted && "cursor-default text-muted-foreground hover:bg-transparent"
      )}
    >
      <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 26 }}>
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center text-muted-foreground/80",
            !expandable && !swatch && "invisible"
          )}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", (open || selected) && "rotate-90")}
          />
        </span>
        {swatch ? (
          <span className="flex w-[22px] shrink-0 justify-center">
            <span className="size-2.5 rounded-[3px]" style={{ background: swatch }} />
          </span>
        ) : Icon ? (
          <span
            className={cn(
              "flex shrink-0 items-center justify-center text-muted-foreground",
              top ? "size-7 rounded-lg bg-muted" : "size-[22px]"
            )}
          >
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <span
          className={cn(
            "flex min-w-0 leading-[1.3]",
            top ? "flex-col items-start" : "flex-row items-baseline gap-2"
          )}
        >
          <span
            className={cn(
              "max-w-full shrink-0 truncate",
              top
                ? "text-sm font-medium"
                : swatch
                  ? "text-[0.8125rem]"
                  : "text-[0.8125rem] font-medium"
            )}
          >
            {title}
          </span>
          {text ? (
            <span
              className={cn(
                "min-w-0 truncate text-muted-foreground",
                top ? "text-xs" : "text-[0.8125rem]"
              )}
            >
              {quote ? `“${text}”` : text}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {mix.length > 0 ? (
          <span className="flex h-1.5 w-14 shrink-0 gap-0.5">
            {mix.map((part) => (
              <span
                key={part.key}
                className="block h-full min-w-[3px] rounded-[2px]"
                style={{ flex: `${part.weight} 1 0`, background: part.color }}
              />
            ))}
          </span>
        ) : null}
        {leading ? (
          <span className="truncate text-[0.78rem] text-foreground/80">
            {leading.name}
            {mix.length > 1 ? ` +${mix.length - 1}` : ""}
          </span>
        ) : null}
      </span>
      <span className="text-right text-[0.8125rem] text-foreground/80 tabular-nums">
        {measured ? measured.modelCallCount.toLocaleString(locale) : ""}
      </span>
      <span className="text-right text-[0.8125rem] text-foreground/80 tabular-nums">
        {measured ? compact(measured.totalTokens, locale) : ""}
      </span>
      <span className="text-right text-[0.8125rem] text-foreground/80 tabular-nums">
        {measured ? percent(cachedShare(measured), locale) : ""}
      </span>
      <span
        className={cn(
          "text-right text-[0.84rem] tabular-nums",
          top ? "font-semibold" : "font-medium"
        )}
      >
        {cost ??
          (measured ? fineMoney(costOf(measured, context.currency), context.currency, locale) : "")}
      </span>
      <span className="text-right text-[0.78rem] text-muted-foreground tabular-nums">{at}</span>
    </div>
  )
}

/** Each model's share of a row's spend, by calls when nothing is priced, costliest first. */
function modelMix(models: readonly GroupExecution["models"][number][], context: Context) {
  const merged = new Map<string, { name: string; cost: number; calls: number }>()
  for (const model of models) {
    const key = modelKey(model)
    const entry = merged.get(key) ?? { name: model.modelId, cost: 0, calls: 0 }
    entry.cost += costOf(model, context.currency)
    entry.calls += model.modelCallCount
    merged.set(key, entry)
  }
  const priced = [...merged.values()].some((entry) => entry.cost > 0)
  return [...merged]
    .map(([key, entry]) => ({
      key,
      name: entry.name,
      color: colorOf(context.palette, key),
      weight: priced ? entry.cost : entry.calls,
    }))
    .filter((part) => part.weight > 0)
    .sort((a, b) => b.weight - a.weight)
}

function groupKind(group: Group): "chat" | "workflow" | "action" | "other" {
  switch (group.attribution?.kind) {
    case "agent":
      return "chat"
    case "workflowAgent":
    case "workflow":
      return "workflow"
    case "action":
      return "action"
    default:
      return "other"
  }
}

const groupIcons = { chat: MessageSquare, workflow: Workflow, action: Zap, other: SquareTerminal }

function GroupRow({ group, context }: { readonly group: Group; readonly context: Context }) {
  const messages = useAiUsageMessages().runs
  const names = useNames()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const kind = groupKind(group)
  const turns = group.executions.filter((execution) => execution.attribution?.kind === "agent")
  const subagents = group.executions.filter(
    (execution) => execution.attribution?.kind === "subagent"
  )
  const person = group.requester ? names.person(group.requester) : undefined

  const title =
    kind === "chat"
      ? (group.label ??
        (group.canOpenThread ? messages.conversation : messages.privateConversation))
      : group.attribution?.kind === "workflowAgent" || group.attribution?.kind === "workflow"
        ? group.attribution.workflowId
        : group.attribution?.kind === "action"
          ? group.attribution.actionId
          : messages.request
  const meta = [
    kind === "chat"
      ? messages.chat
      : kind === "workflow"
        ? messages.workflowRun
        : kind === "action"
          ? messages.actionRun
          : messages.request,
    person,
    // A filter can keep only a sub-agent's calls, so a conversation can show no turns.
    kind === "chat" && turns.length > 0 ? messages.turns(turns.length) : undefined,
    kind === "chat" && subagents.length > 0 ? messages.subagents(subagents.length) : undefined,
    kind === "workflow" ? messages.steps(group.executions.length) : undefined,
  ].filter(Boolean)

  return (
    <>
      <TreeRow
        depth={0}
        top
        icon={groupIcons[kind]}
        title={title}
        text={meta.join(" · ")}
        models={group.executions.flatMap((execution) => execution.models)}
        measured={group}
        at={whenLabel(group.lastCallAt, locale)}
        expandable
        open={open}
        onClick={() => setOpen((value) => !value)}
        context={context}
      />
      {open ? (
        kind === "chat" ? (
          <Conversation group={group} context={context} />
        ) : kind === "workflow" ? (
          group.executions.map((execution) => (
            <ExecutionRow
              key={execution.executionId}
              group={group}
              execution={execution}
              depth={1}
              icon={Bot}
              title={
                execution.attribution?.kind === "workflowAgent"
                  ? execution.attribution.agentStepId
                  : messages.step
              }
              text={messages.step}
              context={context}
            />
          ))
        ) : (
          group.executions.map((execution) => (
            <Calls
              key={execution.executionId}
              group={group}
              executionId={execution.executionId}
              depth={1}
              context={context}
            />
          ))
        )
      ) : null}
    </>
  )
}

/** A conversation's turns, latest first, each with its calls and the sub-agents it started. */
function Conversation({ group, context }: { readonly group: Group; readonly context: Context }) {
  const messages = useAiUsageMessages().runs
  const [all, setAll] = useState(false)
  const turns = group.executions
    .filter((execution) => execution.attribution?.kind === "agent")
    .map((execution, index) => ({ execution, number: index + 1 }))
    .reverse()
  const turnRuns = new Set(
    turns.flatMap(({ execution }) =>
      execution.attribution?.kind === "agent" ? [execution.attribution.agentRunId] : []
    )
  )
  // Sub-agents whose turn made no matching call of its own still belong to the conversation.
  const orphans = group.executions.filter(
    (execution) =>
      execution.attribution?.kind === "subagent" && !turnRuns.has(execution.attribution.parentRunId)
  )
  const shown = all ? turns : turns.slice(0, latestTurns)
  const earlier = turns.slice(latestTurns)

  return (
    <>
      {shown.map(({ execution, number }) => (
        <ExecutionRow
          key={execution.executionId}
          group={group}
          execution={execution}
          depth={1}
          icon={User}
          title={`${messages.turn} ${number}`}
          text={execution.prompt}
          quote={execution.prompt !== undefined}
          subagents={group.executions.filter(
            (candidate) =>
              candidate.attribution?.kind === "subagent" &&
              execution.attribution?.kind === "agent" &&
              candidate.attribution.parentRunId === execution.attribution.agentRunId
          )}
          context={context}
        />
      ))}
      {!all && earlier.length > 0 ? (
        <TreeRow
          depth={1}
          icon={Ellipsis}
          title={messages.earlierTurns(earlier.length)}
          models={earlier.flatMap(({ execution }) => execution.models)}
          measured={sum(earlier.map(({ execution }) => execution))}
          onClick={() => setAll(true)}
          context={context}
        />
      ) : null}
      {orphans.map((execution) => (
        <ExecutionRow
          key={execution.executionId}
          group={group}
          execution={execution}
          depth={1}
          icon={Bot}
          title={execution.label ?? messages.subagent}
          text={messages.subagent}
          context={context}
        />
      ))}
    </>
  )
}

function sum(executions: readonly GroupExecution[]): Measured {
  const add = (key: "totalTokens" | "inputTokens" | "cacheReadInputTokens") =>
    executions.every((execution) => execution[key] === undefined)
      ? undefined
      : executions.reduce((total, execution) => total + (execution[key] ?? 0), 0)
  const amounts = new Map<string, bigint>()
  for (const execution of executions) {
    for (const amount of execution.costs.amounts) {
      amounts.set(
        amount.currency,
        (amounts.get(amount.currency) ?? 0n) + BigInt(amount.amountNanos)
      )
    }
  }
  return {
    modelCallCount: executions.reduce((total, execution) => total + execution.modelCallCount, 0),
    totalTokens: add("totalTokens"),
    inputTokens: add("inputTokens"),
    cacheReadInputTokens: add("cacheReadInputTokens"),
    costs: {
      amounts: [...amounts].map(([currency, nanos]) => ({
        currency,
        amountNanos: nanos.toString(),
      })),
      ratedCallCount: 0,
      unpriceableCallCount: 0,
      unvaluedCallCount: 0,
    },
  }
}

/** A turn, a step or a sub-agent: its totals, opening onto its calls and any sub-agents. */
function ExecutionRow({
  group,
  execution,
  depth,
  icon,
  title,
  text,
  quote,
  subagents = [],
  context,
}: {
  readonly group: Group
  readonly execution: GroupExecution
  readonly depth: number
  readonly icon: LucideIcon
  readonly title: string
  readonly text?: string
  readonly quote?: boolean
  readonly subagents?: readonly GroupExecution[]
  readonly context: Context
}) {
  const messages = useAiUsageMessages().runs
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const all = [execution, ...subagents]
  return (
    <>
      <TreeRow
        depth={depth}
        icon={icon}
        title={title}
        text={text}
        quote={quote}
        models={all.flatMap((entry) => entry.models)}
        measured={subagents.length > 0 ? sum(all) : execution}
        at={whenLabel(execution.firstCallAt, locale)}
        expandable
        open={open}
        onClick={() => setOpen((value) => !value)}
        context={context}
      />
      {open ? (
        <>
          <Calls
            group={group}
            executionId={execution.executionId}
            depth={depth + 1}
            context={context}
          />
          {subagents.map((subagent) => (
            <ExecutionRow
              key={subagent.executionId}
              group={group}
              execution={subagent}
              depth={depth + 1}
              icon={Bot}
              title={subagent.label ?? messages.subagent}
              text={messages.subagent}
              context={context}
            />
          ))}
        </>
      ) : null}
    </>
  )
}

/** One execution's calls, loaded when it opens. */
function Calls({
  group,
  executionId,
  depth,
  context,
}: {
  readonly group: Group
  readonly executionId: string
  readonly depth: number
  readonly context: Context
}) {
  const messages = useAiUsageMessages().runs
  const kinds = useAiUsageMessages().kinds.names
  const locale = useLocale()
  const [selected, setSelected] = useState<string>()
  const { data, isPending, isError } = useQuery({
    ...listAiModelCallsOptions({
      query: {
        ...context.range,
        ...apiFilters(context.filters),
        ...(context.filters.price ? { valuationStatus: context.filters.price } : {}),
        executionId,
        limit: String(largestPage),
      },
    }),
    retry: false,
  })
  if (isPending || isError) {
    return (
      <div
        className="border-t border-border/40 py-3 text-[0.8125rem] text-muted-foreground"
        style={{ paddingLeft: 20 + depth * 26 + 24 }}
      >
        {isError ? messages.failed : messages.loading}
      </div>
    )
  }
  const calls = [...data.items].sort((a, b) => a.usage.occurredAt.localeCompare(b.usage.occurredAt))
  return (
    <>
      {calls.map((call) => {
        const key = modelKey({
          providerId: call.usage.providerId,
          modelId: call.usage.requestedModelId,
        })
        const note = [
          call.usage.modelKind && call.usage.modelKind !== "language"
            ? kinds[call.usage.modelKind]
            : undefined,
          call.usage.attempt > 1 ? messages.attempt(call.usage.attempt) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
        const isSelected = selected === call.usage.id
        const usage = call.usage.usage
        return (
          <div key={call.usage.id} className="contents">
            <TreeRow
              depth={depth}
              swatch={colorOf(context.palette, key)}
              title={call.usage.requestedModelId}
              text={note}
              measured={{
                modelCallCount: 1,
                totalTokens: usage.totalTokens,
                inputTokens: usage.inputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                costs: {
                  amounts: [],
                  ratedCallCount: 0,
                  unpriceableCallCount: 0,
                  unvaluedCallCount: 0,
                },
              }}
              cost={
                call.cost?.status === "rated"
                  ? fineMoney(
                      Number(call.cost.money.amountNanos) / 1e9,
                      call.cost.money.currency,
                      locale
                    )
                  : "—"
              }
              at={new Date(call.usage.occurredAt).toLocaleTimeString(locale, {
                hour: "numeric",
                minute: "2-digit",
              })}
              selected={isSelected}
              onClick={() => setSelected(isSelected ? undefined : call.usage.id)}
              context={context}
            />
            {isSelected ? (
              <CallDetail call={call} group={group} depth={depth} currency={context.currency} />
            ) : null}
          </div>
        )
      })}
    </>
  )
}
