import type {
  GetAiLimitStatusResponse,
  GetAiLimitSubjectOptionsResponse,
  ListAiLimitPoliciesResponse,
} from "@sixb/client"
import {
  createAiLimitPolicyMutation,
  deleteAiLimitPolicyMutation,
  getAiLimitStatusOptions,
  getAiLimitStatusQueryKey,
  getAiLimitSubjectOptionsOptions,
  listAiLimitPoliciesOptions,
  listAiLimitPoliciesQueryKey,
  updateAiLimitPolicyMutation,
} from "@sixb/client/hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Switch,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleGauge, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { type SubmitEvent, useState } from "react"
import { notify } from "../../section-page"
import {
  apiErrorMessage,
  Field,
  PageSection,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  Pill,
  type Tone,
  useLoadFailure,
} from "../../section-ui"
import {
  formatLimitQuantity,
  type LimitMeter,
  type LimitQuantity,
  type LimitSubjectType,
  limitAmountInput,
  limitSubjectChoices,
  limitUsedPercent,
  parseLimitAmount,
  quantityIsPositive,
} from "./format"
import { useAiUsageMessages } from "./messages"

type LimitStatus = GetAiLimitStatusResponse["items"][number]
type LimitPolicy = ListAiLimitPoliciesResponse["items"][number]
type LimitSubject = LimitPolicy["subject"]
type SubjectOptions = GetAiLimitSubjectOptionsResponse

/** The query the page also refreshes: limits stay listed, disabled ones included. */
export const limitStatusQuery = { query: { includeDisabled: "true" as const } }

/**
 * This month's limits on AI usage and how much of each is spent. Anyone who may observe AI usage
 * sees them; anyone who may manage it adds, changes and removes them.
 */
export function AiLimits() {
  const messages = useAiUsageMessages().limits
  const locale = useLocale()
  const queryClient = useQueryClient()
  const statusQuery = useQuery({ ...getAiLimitStatusOptions(limitStatusQuery), retry: false })
  const policyQuery = useQuery({ ...listAiLimitPoliciesOptions(limitStatusQuery), retry: false })
  const [editing, setEditing] = useState<LimitPolicy | "new" | null>(null)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getAiLimitStatusQueryKey(limitStatusQuery) }),
      queryClient.invalidateQueries({ queryKey: listAiLimitPoliciesQueryKey(limitStatusQuery) }),
    ])
  const create = useMutation({
    ...createAiLimitPolicyMutation(),
    onSuccess: async () => {
      setEditing(null)
      notify.success(messages.created)
      await refresh()
    },
  })
  // The dialog shows its own save's failure; turning a limit on or off from its row toasts.
  const update = useMutation({
    ...updateAiLimitPolicyMutation(),
    onSuccess: async () => {
      setEditing(null)
      notify.success(messages.updated)
      await refresh()
    },
  })
  const toggle = useMutation({
    ...updateAiLimitPolicyMutation(),
    onSuccess: async () => {
      notify.success(messages.updated)
      await refresh()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.updateFailed)),
  })
  const openDialog = (policy: LimitPolicy | "new") => {
    create.reset()
    update.reset()
    setEditing(policy)
  }
  const remove = useMutation({
    ...deleteAiLimitPolicyMutation(),
    onSuccess: async () => {
      notify.success(messages.deleted)
      await refresh()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.deleteFailed)),
  })

  const statuses = statusQuery.data?.items ?? []
  const failure = useLoadFailure(policyQuery.error ?? statusQuery.error, {
    denied: messages.denied,
    fallback: messages.unavailable,
  })
  const canManage =
    policyQuery.data?.capabilities.manage ?? statusQuery.data?.capabilities.manage ?? false
  const subjectsQuery = useQuery({
    ...getAiLimitSubjectOptionsOptions(),
    enabled: canManage,
    retry: false,
  })
  const subjects = subjectsQuery.data
  const statusById = new Map(statuses.map((status) => [status.policy.id, status]))
  const policies = policyQuery.data?.items ?? statuses.map((status) => status.policy)
  const active = policies.filter((policy) => policy.enabled).length
  const busy = create.isPending || update.isPending || toggle.isPending || remove.isPending
  const period = statuses[0]?.period
  const utcDay = (value: string, year: boolean) =>
    new Date(value).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(year ? { year: "numeric" } : {}),
      timeZone: "UTC",
    })

  return (
    <PageSection
      title={messages.title}
      description={
        period
          ? messages.period(utcDay(period.start, false), utcDay(period.end, true), active)
          : messages.resetsMonthly
      }
      action={
        canManage ? (
          <Button type="button" size="sm" variant="outline" onClick={() => openDialog("new")}>
            <Plus />
            {messages.add}
          </Button>
        ) : null
      }
    >
      <Panel>
        {statusQuery.isPending && policyQuery.isPending ? (
          <PanelSkeleton rows={2} />
        ) : !statusQuery.data && !policyQuery.data ? (
          <PanelEmpty
            tone="error"
            icon={CircleGauge}
            title={failure.title}
            description={failure.description}
          />
        ) : policies.length === 0 ? (
          <PanelEmpty icon={CircleGauge} title={messages.emptyTitle} description={messages.empty} />
        ) : (
          policies.map((policy) => (
            <LimitRow
              key={policy.id}
              policy={policy}
              status={statusById.get(policy.id)}
              subjects={subjects}
              canManage={canManage}
              busy={busy}
              onEdit={() => openDialog(policy)}
              onToggle={() =>
                toggle.mutate({ path: { limitId: policy.id }, body: { enabled: !policy.enabled } })
              }
              onDelete={() => remove.mutate({ path: { limitId: policy.id } })}
            />
          ))
        )}
      </Panel>

      {editing !== null ? (
        <LimitDialog
          key={editing === "new" ? "new" : editing.id}
          policy={editing === "new" ? undefined : editing}
          subjects={subjects}
          subjectsError={subjectsQuery.error}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
          onClose={() => setEditing(null)}
          onCreate={(input) => create.mutate({ body: input })}
          onUpdate={(limitId, input) => update.mutate({ path: { limitId }, body: input })}
        />
      ) : null}
    </PageSection>
  )
}

function useSubjectLabel() {
  const messages = useAiUsageMessages().limits
  return (subject: LimitSubject, subjects: SubjectOptions | undefined): string => {
    if (subject.type === "project") return messages.project
    const choice = limitSubjectChoices(subjects, subject.type, messages.statuses).find(
      (candidate) => candidate.value === subject.id
    )
    return choice?.label ?? messages[subject.type](subject.id)
  }
}

function LimitRow({
  policy,
  status,
  subjects,
  canManage,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly policy: LimitPolicy
  /** Absent for someone who may manage limits but not observe usage. */
  readonly status: LimitStatus | undefined
  readonly subjects: SubjectOptions | undefined
  readonly canManage: boolean
  readonly busy: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
}) {
  const messages = useAiUsageMessages().limits
  const locale = useLocale()
  const label = useSubjectLabel()(policy.subject, subjects)
  const amount = (quantity: LimitQuantity) => formatLimitQuantity(quantity, messages.tokens, locale)
  const consumption = status?.consumption
  const percent = consumption
    ? limitUsedPercent({
        limit: policy.limit,
        actual: consumption.actual,
        reserved: consumption.reserved,
        unknown: consumption.unknown,
      })
    : 0
  const unknown = consumption ? quantityIsPositive(consumption.unknown) : false
  const spent =
    consumption &&
    (quantityIsPositive(consumption.actual) || quantityIsPositive(consumption.reserved) || unknown)
  const percentText =
    spent && percent < 0.01
      ? `<${(0.01).toLocaleString(locale)}%`
      : `${percent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`
  const barTone = status?.exhausted
    ? "bg-red-500"
    : status?.accountingStatus === "unavailable" || unknown || percent >= 80
      ? "bg-amber-500"
      : "bg-[#007aff]"
  const state: { readonly tone: Tone; readonly label: string } = !policy.enabled
    ? { tone: "muted", label: messages.disabled }
    : status?.exhausted
      ? { tone: "error", label: messages.exhausted }
      : status?.accountingStatus === "unavailable"
        ? { tone: "warn", label: messages.accountingUnavailable }
        : { tone: "ok", label: messages.active }

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <Pill tone={state.tone}>{state.label}</Pill>
            {status?.orphaned ? <Pill tone="muted">{messages.orphaned}</Pill> : null}
          </div>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {messages.meters[policy.limit.meter]}
          </p>
        </div>
        {canManage ? (
          <LimitActions
            policy={policy}
            label={label}
            busy={busy}
            onEdit={onEdit}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ) : null}
      </div>

      {status && consumption ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.8125rem]">
            <span className="font-medium tabular-nums">
              {amount(consumption.actual)}{" "}
              <span className="font-normal text-muted-foreground">
                {messages.of(amount(policy.limit))}
              </span>
            </span>
            <span className="text-xs font-medium tabular-nums">{messages.used(percentText)}</span>
          </div>
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={messages.used(percentText)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", barTone)}
              style={{ width: `${percent}%`, minWidth: percent > 0 ? 2 : undefined }}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{messages.remaining(amount(consumption.remaining))}</span>
            {quantityIsPositive(consumption.reserved) ? (
              <span>{messages.reserved(amount(consumption.reserved))}</span>
            ) : null}
            {unknown ? <span>{messages.heldUnknown(amount(consumption.unknown))}</span> : null}
            <span>
              {messages.resets(
                new Date(status.period.resetAt).toLocaleString(locale, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: "UTC",
                  timeZoneName: "short",
                })
              )}
            </span>
          </div>
          {status.accountingStatus === "unavailable" || unknown ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              {status.accountingStatus === "unavailable"
                ? messages.accountingUnavailableNote
                : messages.unknownNote}
            </p>
          ) : null}
          {status.orphaned ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {messages.orphanedNote}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[0.8125rem] text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {messages.monthly(amount(policy.limit))}
          </span>{" "}
          · {messages.needsObserve}
        </p>
      )}
    </div>
  )
}

function LimitActions({
  policy,
  label,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly policy: LimitPolicy
  readonly label: string
  readonly busy: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
}) {
  const messages = useAiUsageMessages().limits
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={messages.actions(label)}
            disabled={busy}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {messages.edit}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggle}>
            {policy.enabled ? messages.disable : messages.enable}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 />
            {messages.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{messages.deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              {messages.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function subjectValue(subject: LimitSubject): string {
  return subject.type === "project" ? "project" : `${subject.type}:${subject.id}`
}

function parseSubjectValue(value: string): LimitSubject {
  if (value === "project") return { type: "project" }
  const separator = value.indexOf(":")
  const type = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (id && (type === "group" || type === "user" || type === "serviceAccount")) return { type, id }
  throw new Error(`[SixbApp] Unknown AI limit subject: ${value}`)
}

function LimitDialog({
  policy,
  subjects,
  subjectsError,
  pending,
  error,
  onClose,
  onCreate,
  onUpdate,
}: {
  /** The limit being edited; absent when adding one. */
  readonly policy?: LimitPolicy
  readonly subjects: SubjectOptions | undefined
  readonly subjectsError: unknown
  readonly pending: boolean
  readonly error: unknown
  readonly onClose: () => void
  readonly onCreate: (input: {
    subject: LimitSubject
    limit: LimitQuantity
    enabled: boolean
  }) => void
  readonly onUpdate: (limitId: string, input: { limit: LimitQuantity; enabled: boolean }) => void
}) {
  const messages = useAiUsageMessages().limits
  const label = useSubjectLabel()
  const [subject, setSubject] = useState<LimitSubject>(policy?.subject ?? { type: "project" })
  // A limit's subject and meter are what it is; editing changes only its amount and whether it
  // is enforced.
  const [meter, setMeter] = useState<LimitMeter>(policy?.limit.meter ?? "cost.catalogEstimated")
  const [amount, setAmount] = useState(policy ? limitAmountInput(policy.limit) : "")
  const [enabled, setEnabled] = useState(policy?.enabled ?? true)
  const [invalid, setInvalid] = useState<keyof typeof messages.errors | null>(null)
  const currency =
    policy?.limit.meter === "cost.catalogEstimated" ? policy.limit.amount.currency : "USD"

  const choices = [
    { value: "project", label: messages.project },
    ...(["group", "user", "serviceAccount"] as const satisfies readonly LimitSubjectType[]).flatMap(
      (type) =>
        limitSubjectChoices(subjects, type, messages.statuses).map((choice) => ({
          value: subjectValue({ type, id: choice.value }),
          label: choice.label,
          description: [messages.subjectTypes[type], choice.description]
            .filter(Boolean)
            .join(" · "),
        }))
    ),
  ]
  if (!choices.some((choice) => choice.value === subjectValue(subject))) {
    choices.push({ value: subjectValue(subject), label: label(subject, subjects) })
  }

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = parseLimitAmount(meter, amount, currency)
    if (!parsed.ok) {
      setInvalid(parsed.error)
      return
    }
    if (policy) onUpdate(policy.id, { limit: parsed.quantity, enabled })
    else onCreate({ subject, limit: parsed.quantity, enabled: true })
  }
  const failure = invalid
    ? messages.errors[invalid]
    : error
      ? apiErrorMessage(error, policy ? messages.updateFailed : messages.createFailed)
      : !policy && subjectsError
        ? apiErrorMessage(subjectsError, messages.subjectsFailed)
        : null

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{policy ? messages.dialogEdit : messages.dialogAdd}</DialogTitle>
            <DialogDescription>{messages.dialogDescription}</DialogDescription>
          </DialogHeader>
          <Field
            label={messages.appliesTo}
            htmlFor="ai-limit-subject"
            hint={messages.appliesToHint}
          >
            <Combobox
              id="ai-limit-subject"
              value={subjectValue(subject)}
              options={choices}
              onValueChange={(value) => {
                setSubject(parseSubjectValue(value))
                setInvalid(null)
              }}
              disabled={policy !== undefined}
              searchPlaceholder={messages.searchSubjects}
              emptyLabel={messages.noSubjects}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={messages.meter}>
              <div className="inline-flex w-full rounded-lg bg-muted/70 p-1 ring-1 ring-border/70">
                {(["cost.catalogEstimated", "tokens.total"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={meter === option}
                    disabled={policy !== undefined}
                    onClick={() => {
                      setMeter(option)
                      setAmount("")
                      setInvalid(null)
                    }}
                    className={cn(
                      "h-7 flex-1 rounded-md text-[0.8125rem] font-medium text-muted-foreground transition-colors disabled:cursor-not-allowed",
                      meter === option && "bg-background text-foreground ring-1 ring-border"
                    )}
                  >
                    {option === "tokens.total" ? messages.tokenMeter : messages.cost}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label={
                meter === "tokens.total" ? messages.tokenAmount : messages.costAmount(currency)
              }
              htmlFor="ai-limit-amount"
            >
              <Input
                id="ai-limit-amount"
                inputMode={meter === "tokens.total" ? "numeric" : "decimal"}
                placeholder={meter === "tokens.total" ? "1000000" : "100.00"}
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value)
                  setInvalid(null)
                }}
              />
            </Field>
          </div>
          {policy ? (
            <label
              htmlFor="ai-limit-enabled"
              className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5"
            >
              <span>
                <span className="block text-sm font-medium">{messages.enforce}</span>
                <span className="block text-xs text-muted-foreground">{messages.enforceHint}</span>
              </span>
              <Switch id="ai-limit-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </label>
          ) : null}
          {failure ? (
            <p className="text-[0.8125rem] text-red-600 dark:text-red-400">{failure}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {messages.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {policy ? messages.save : messages.add}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
