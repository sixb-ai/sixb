import {
  encodeObjectId,
  type GetRuleResponse,
  type ListRuleStatesResponse,
  type ListRulesResponse,
} from "@sixb/client"
import { getRuleOptions, listRuleStatesOptions, listRulesOptions } from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  EmptyState,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { BellRing, ChevronLeft, ChevronRight, ListChecks, Loader2, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  isUnconfiguredStorageError,
  UnrecordedHistoryState,
} from "../components/UnrecordedHistoryState"
import { useRuleLiveUpdates } from "../features/rules/hooks/useRuleLiveUpdates"
import { formatValue } from "../lib/formatValue"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type RuleSummary = ListRulesResponse[number] | GetRuleResponse
type RuleState = ListRuleStatesResponse["states"][number]
type RulesListViewStyle = "cards" | "table"
type RulePredicateKind = "all" | "any" | "not" | "property" | "link"

const rulesListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

function ruleName(rule: Pick<RuleSummary, "id">): string {
  return humanizeIdentifier(rule.id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function predicateKind(value: unknown): RulePredicateKind | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null
  if (
    value.kind === "all" ||
    value.kind === "any" ||
    value.kind === "not" ||
    value.kind === "property" ||
    value.kind === "link"
  ) {
    return value.kind
  }
  return null
}

function propertyOperatorLabel(op: string): string {
  switch (op) {
    case "eq":
      return "="
    case "notEq":
      return "!="
    case "gt":
      return ">"
    case "gte":
      return ">="
    case "lt":
      return "<"
    case "lte":
      return "<="
    case "isPresent":
      return "present"
    case "isMissing":
      return "missing"
    default:
      return op
  }
}

function formatPredicateValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "number" || typeof value === "boolean") return formatValue(value)
  if (value === null) return "null"
  return ""
}

function childPredicates(predicate: Record<string, unknown>): unknown[] {
  return Array.isArray(predicate.predicates) ? predicate.predicates : []
}

function describePredicate(predicate: unknown): string {
  if (!isRecord(predicate)) return "Unknown predicate"

  const kind = predicateKind(predicate)
  if (kind === "property") {
    const propertyId = typeof predicate.propertyId === "string" ? predicate.propertyId : "property"
    const op = typeof predicate.op === "string" ? predicate.op : ""
    if (op === "isPresent" || op === "isMissing") {
      return `${propertyId} is ${propertyOperatorLabel(op)}`
    }
    return `${propertyId} ${propertyOperatorLabel(op)} ${formatPredicateValue(predicate.value)}`
  }

  if (kind === "link") {
    const linkId = typeof predicate.linkId === "string" ? predicate.linkId : "link"
    return `${linkId} ${predicate.op === "exists" ? "exists" : "missing"}`
  }

  if (kind === "not") {
    return `Not ${describePredicate(predicate.predicate)}`
  }

  if (kind === "all" || kind === "any") {
    const count = childPredicates(predicate).length
    return `${kind === "all" ? "All" : "Any"} of ${count}`
  }

  return "Unknown predicate"
}

function predicateSearchText(predicate: unknown): string {
  if (!isRecord(predicate)) return ""
  const kind = predicateKind(predicate)
  const own = describePredicate(predicate)

  if (kind === "all" || kind === "any") {
    return [own, ...childPredicates(predicate).map(predicateSearchText)].join(" ")
  }

  if (kind === "not") {
    return [own, predicateSearchText(predicate.predicate)].join(" ")
  }

  return own
}

function dependencyLabel(dependency: RuleSummary["dependencies"][number]): string {
  switch (dependency.type) {
    case "object.created":
      return `Object ${dependency.objectTypeId} created`
    case "object.updated":
      return `Object ${dependency.objectTypeId} updated`
    case "object.deleted":
      return `Object ${dependency.objectTypeId} deleted`
    case "link.created":
      return `Link ${dependency.sourceTypeId}.${dependency.linkId} created`
    case "link.updated":
      return `Link ${dependency.sourceTypeId}.${dependency.linkId} updated`
    case "link.deleted":
      return `Link ${dependency.sourceTypeId}.${dependency.linkId} deleted`
  }
}

function dependencyEventLabel(dependency: RuleSummary["dependencies"][number]): string {
  switch (dependency.type) {
    case "object.created":
      return `${dependency.objectTypeId} created`
    case "object.updated":
      return `${dependency.objectTypeId} updated`
    case "object.deleted":
      return `${dependency.objectTypeId} deleted`
    case "link.created":
      return `${dependency.sourceTypeId}.${dependency.linkId} created`
    case "link.updated":
      return `${dependency.sourceTypeId}.${dependency.linkId} updated`
    case "link.deleted":
      return `${dependency.sourceTypeId}.${dependency.linkId} deleted`
  }
}

/**
 * What the badge is allowed to claim.
 *
 * An empty `states` array is only a count of zero once the query has answered — loading, failed
 * and unrecorded are all empty for reasons that say nothing about the rule.
 */
export type ActiveStateCount =
  | { readonly kind: "known"; readonly count: number }
  | { readonly kind: "loading" }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "error" }

/**
 * The reason a rule-state query cannot support a count, or `null` when it can. Read once per query
 * and shared by every row, so a list cannot show one rule as unrecorded and the next as zero.
 */
export function unknownActiveStates(query: {
  isLoading: boolean
  isError: boolean
  error: unknown
}): Exclude<ActiveStateCount, { kind: "known" }> | null {
  // Before `isError`: a 501 is an error to the query client and a fact about the
  // deployment to a reader.
  if (isUnconfiguredStorageError(query.error)) return { kind: "unrecorded" }
  if (query.isLoading) return { kind: "loading" }
  if (query.isError) return { kind: "error" }
  return null
}

function ActiveStateBadge({ count }: { count: ActiveStateCount }) {
  // A badge that appears saying one thing and then changes is worse than one that arrives late.
  if (count.kind === "loading") {
    return null
  }

  if (count.kind === "unrecorded") {
    return (
      <Badge variant="outline" className="rounded-md border-border text-muted-foreground">
        Not recorded
      </Badge>
    )
  }

  if (count.kind === "error") {
    return (
      <Badge variant="outline" className="rounded-md border-border text-muted-foreground">
        Unavailable
      </Badge>
    )
  }

  if (count.count === 0) {
    return (
      <Badge variant="outline" className="rounded-md border-border text-muted-foreground">
        None active
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="rounded-md border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
    >
      <BellRing className="h-3 w-3" />
      {count.count} active
    </Badge>
  )
}

function RuleIcon({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
        active
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-200"
          : "bg-muted text-muted-foreground"
      )}
    >
      <ListChecks className="h-4 w-4" />
    </div>
  )
}

function RuleListItem({
  rule,
  activeCount,
  onSelect,
}: {
  rule: ListRulesResponse[number]
  activeCount: ActiveStateCount
  onSelect: () => void
}) {
  const active = activeCount.kind === "known" && activeCount.count > 0
  return (
    <CollectionCardButton
      onClick={onSelect}
      className={cn(active && "border-amber-500/40 bg-amber-500/5")}
    >
      <RuleIcon active={active} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{ruleName(rule)}</p>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {rule.subject.objectTypeId}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{rule.id}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {describePredicate(rule.predicate)}
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        <ActiveStateBadge count={activeCount} />
        <span className="text-xs text-muted-foreground">
          {rule.dependencies.length} dependenc{rule.dependencies.length === 1 ? "y" : "ies"}
        </span>
      </div>
    </CollectionCardButton>
  )
}

function RuleTableView({
  rules,
  activeCount,
  onSelect,
}: {
  rules: ListRulesResponse
  activeCount: (ruleId: string) => ActiveStateCount
  onSelect: (ruleId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead className="hidden sm:table-cell">Subject</TableHead>
            <TableHead className="hidden md:table-cell">Predicate</TableHead>
            <TableHead>Active</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Dependencies</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => {
            return (
              <TableRow key={rule.id} onClick={() => onSelect(rule.id)} className="cursor-pointer">
                <TableCell className="max-w-[260px]">
                  <p className="truncate text-sm font-medium text-foreground">{ruleName(rule)}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {rule.id}
                  </p>
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                  {rule.subject.objectTypeId}
                </TableCell>
                <TableCell className="hidden max-w-[280px] text-xs text-muted-foreground md:table-cell">
                  <span className="block truncate">{describePredicate(rule.predicate)}</span>
                </TableCell>
                <TableCell>
                  <ActiveStateBadge count={activeCount(rule.id)} />
                </TableCell>
                <TableCell className="hidden text-right text-sm text-muted-foreground lg:table-cell">
                  {rule.dependencies.length}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function PredicateGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

function PredicateGroupBody({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 ml-1 space-y-2 border-l border-border pl-4">{children}</div>
}

function PropertyTerm({ record }: { record: Record<string, unknown> }) {
  const propertyId = typeof record.propertyId === "string" ? record.propertyId : "property"
  const op = typeof record.op === "string" ? record.op : ""

  if (op === "isPresent" || op === "isMissing") {
    return (
      <p className="font-mono text-sm text-foreground">
        <span>{propertyId}</span>{" "}
        <span className="text-muted-foreground">
          is {op === "isPresent" ? "present" : "missing"}
        </span>
      </p>
    )
  }

  return (
    <p className="font-mono text-sm text-foreground">
      <span>{propertyId}</span>{" "}
      <span className="text-muted-foreground">{propertyOperatorLabel(op)}</span>{" "}
      <span>{formatPredicateValue(record.value)}</span>
    </p>
  )
}

function LinkTerm({ record }: { record: Record<string, unknown> }) {
  const linkId = typeof record.linkId === "string" ? record.linkId : "link"
  const op = record.op === "exists" ? "exists" : "missing"
  return (
    <p className="font-mono text-sm text-foreground">
      <span>{linkId}</span> <span className="text-muted-foreground">{op}</span>
    </p>
  )
}

function PredicateExpression({ predicate }: { predicate: unknown }) {
  if (!isRecord(predicate)) {
    return <p className="text-sm text-muted-foreground">Unknown predicate</p>
  }

  const kind = predicateKind(predicate)
  if (!kind) {
    return <p className="text-sm text-muted-foreground">Unknown predicate</p>
  }

  if (kind === "property") {
    return <PropertyTerm record={predicate} />
  }

  if (kind === "link") {
    return <LinkTerm record={predicate} />
  }

  if (kind === "not") {
    return (
      <div className="min-w-0">
        <PredicateGroupLabel>Not</PredicateGroupLabel>
        <PredicateGroupBody>
          <PredicateExpression predicate={predicate.predicate} />
        </PredicateGroupBody>
      </div>
    )
  }

  const children = childPredicates(predicate)
  return (
    <div className="min-w-0">
      <PredicateGroupLabel>{kind === "all" ? "All of" : "Any of"}</PredicateGroupLabel>
      <PredicateGroupBody>
        {children.map((child, index) => (
          <PredicateExpression key={`${kind}-${index}`} predicate={child} />
        ))}
      </PredicateGroupBody>
    </div>
  )
}

function RuleStateCard({
  state,
  onSelectObject,
}: {
  state: RuleState
  onSelectObject: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onSelectObject}
      className="h-auto w-full min-w-0 max-w-full flex-col items-stretch overflow-hidden p-3 text-left"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="truncate font-mono text-xs text-foreground">{state.subject.primaryId}</p>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <p className="mt-2 text-xs font-normal text-muted-foreground">
        Triggered {formatRelativeTime(state.triggeredAt)}
      </p>
    </Button>
  )
}

function RuleStatesList({
  states,
  onSelectObject,
}: {
  states: RuleState[]
  onSelectObject: (state: RuleState) => void
}) {
  if (states.length === 0) {
    return (
      <EmptyState
        icon={<BellRing className="h-10 w-10" />}
        title="No active states"
        description="Triggered subjects will appear here."
        className="py-8"
      />
    )
  }

  return (
    <>
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden md:hidden">
        {states.map((state) => (
          <RuleStateCard
            key={`${state.ruleId}:${state.subject.objectTypeId}:${state.subject.primaryId}`}
            state={state}
            onSelectObject={() => onSelectObject(state)}
          />
        ))}
      </div>
      <div className="hidden overflow-hidden rounded-xl border border-border md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-auto" />
            <col className="w-44" />
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-muted text-xs text-muted-foreground">
              <th className="py-2 pl-4 pr-3 font-medium">Object</th>
              <th className="px-3 py-2 font-medium">Triggered</th>
              <th className="py-2 pl-3 pr-4 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {states.map((state) => (
              <tr
                key={`${state.ruleId}:${state.subject.objectTypeId}:${state.subject.primaryId}`}
                className="group cursor-pointer transition-colors hover:bg-muted"
                onClick={() => onSelectObject(state)}
              >
                <td className="py-2.5 pl-4 pr-3">
                  <p className="truncate font-mono text-xs text-foreground">
                    {state.subject.primaryId}
                  </p>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {formatRelativeTime(state.triggeredAt)}
                </td>
                <td className="py-2.5 pl-3 pr-4 text-right">
                  <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function RulesContent({
  rules,
  filteredRules,
  viewStyle,
  activeCount,
  onSelectRule,
}: {
  rules: ListRulesResponse
  filteredRules: ListRulesResponse
  viewStyle: RulesListViewStyle
  activeCount: (ruleId: string) => ActiveStateCount
  onSelectRule: (ruleId: string) => void
}) {
  if (rules.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-10 w-10" />}
        title="No rules"
        description="Registered rules will appear here."
      />
    )
  }

  if (filteredRules.length === 0) {
    return (
      <EmptyState
        icon={<Search className="h-9 w-9" />}
        title="No results"
        description="Try another search."
        className="py-12"
      />
    )
  }

  if (viewStyle === "table") {
    return <RuleTableView rules={filteredRules} activeCount={activeCount} onSelect={onSelectRule} />
  }

  return (
    <CollectionCardGrid>
      {filteredRules.map((rule) => (
        <RuleListItem
          key={rule.id}
          rule={rule}
          activeCount={activeCount(rule.id)}
          onSelect={() => onSelectRule(rule.id)}
        />
      ))}
    </CollectionCardGrid>
  )
}

export function RulesPage() {
  const rulesQuery = useQuery(listRulesOptions())
  const statesQuery = useQuery(listRuleStatesOptions({ query: { order: "desc" } }))
  useRuleLiveUpdates({ enabled: (rulesQuery.data?.length ?? 0) > 0 })
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<RulesListViewStyle>(() =>
    getCollectionViewStyle("rules", ["cards", "table"], "cards")
  )

  const rules = rulesQuery.data ?? []
  const states = statesQuery.data?.states ?? []
  const unknownStates = unknownActiveStates(statesQuery)
  const activeCountByRule = useMemo(() => {
    const counts = new Map<string, number>()
    for (const state of states) {
      counts.set(state.ruleId, (counts.get(state.ruleId) ?? 0) + 1)
    }
    return counts
  }, [states])
  // Only consulted when the query supports a count, so a rule absent from the map is genuinely
  // at zero rather than unknown.
  const activeCount = (ruleId: string): ActiveStateCount =>
    unknownStates ?? { kind: "known", count: activeCountByRule.get(ruleId) ?? 0 }

  const filteredRules = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return rules

    return rules.filter((rule) => {
      return (
        rule.id.toLowerCase().includes(query) ||
        rule.subject.objectTypeId.toLowerCase().includes(query) ||
        predicateSearchText(rule.predicate).toLowerCase().includes(query) ||
        rule.dependencies.some((dependency) =>
          dependencyLabel(dependency).toLowerCase().includes(query)
        )
      )
    })
  }, [rules, searchQuery])

  if (rulesQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading rules...</span>
        </div>
      </div>
    )
  }

  if (rulesQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<ListChecks className="h-10 w-10" />}
            title="Rules unavailable"
            description="Could not load rule metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectRule = (ruleId: string) => {
    navigate(`/rules/${encodeURIComponent(ruleId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Rules"
        count={filteredRules.length}
        actions={
          rules.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={rulesListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("rules", style)
              }}
            />
          ) : null
        }
      />

      {rules.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search rules, subjects, or predicates..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        <RulesContent
          rules={rules}
          filteredRules={filteredRules}
          viewStyle={viewStyle}
          activeCount={activeCount}
          onSelectRule={handleSelectRule}
        />
      </div>
    </div>
  )
}

export function RuleDetailPage() {
  const { ruleId = "" } = useParams()
  const navigate = useNavigate()
  const decodedRuleId = decodeURIComponent(ruleId)
  useRuleLiveUpdates({ ruleId: decodedRuleId, enabled: decodedRuleId.length > 0 })

  const ruleQuery = useQuery({
    ...getRuleOptions({
      path: { ruleId: decodedRuleId },
    }),
    enabled: decodedRuleId.length > 0,
  })

  const statesQuery = useQuery({
    ...listRuleStatesOptions({
      query: { ruleId: decodedRuleId, order: "desc" },
    }),
    enabled: decodedRuleId.length > 0,
  })

  const rule = ruleQuery.data
  const states = statesQuery.data?.states ?? []

  const handleSelectObject = (state: RuleState) => {
    navigate(`/${encodeObjectId(state.subject.objectTypeId, state.subject.primaryId)}`)
  }

  if (ruleQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading rule...</span>
        </div>
      </div>
    )
  }

  if (ruleQuery.isError || !rule) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/rules")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Rules
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<ListChecks className="h-10 w-10" />}
            title="Rule not found"
            description="This rule is not registered in the active Sixb runtime."
          />
        </div>
      </div>
    )
  }

  // The panel below already distinguishes an unrecorded history from an empty one; the badge used
  // to contradict it, reading "None active" directly above "Rule state is not recorded".
  const activeTotal: ActiveStateCount = unknownActiveStates(statesQuery) ?? {
    kind: "known",
    count: statesQuery.data?.total ?? states.length,
  }
  const triggers = rule.dependencies.map(dependencyEventLabel)

  return (
    <div className="mx-auto w-full max-w-4xl min-w-0 space-y-8 overflow-hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/rules")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Rules
      </Button>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
            {ruleName(rule)}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Object rule on{" "}
            <span className="font-mono text-foreground">{rule.subject.objectTypeId}</span>
            <span className="mx-1.5 text-border">·</span>
            <span className="font-mono">{rule.id}</span>
          </p>
        </div>
        <ActiveStateBadge count={activeTotal} />
      </header>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-normal text-foreground">Definition</h2>
          {triggers.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Triggered by{" "}
              {triggers.map((trigger, index) => (
                <span key={trigger}>
                  {index > 0 && <span className="text-border">, </span>}
                  <span className="font-mono text-foreground/80">{trigger}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="rounded-xl bg-muted px-5 py-4 sm:px-6 sm:py-5">
          <PredicateExpression predicate={rule.predicate} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-normal text-foreground">Active states</h2>
        {statesQuery.isLoading ? (
          <div className="py-10">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading states...</span>
            </div>
          </div>
        ) : isUnconfiguredStorageError(statesQuery.error) ? (
          <UnrecordedHistoryState what="Rule state" />
        ) : statesQuery.isError ? (
          <EmptyState
            icon={<BellRing className="h-10 w-10" />}
            title="States unavailable"
            description="Could not load active rule states."
            className="py-8"
          />
        ) : (
          <RuleStatesList states={states} onSelectObject={handleSelectObject} />
        )}
      </section>
    </div>
  )
}
