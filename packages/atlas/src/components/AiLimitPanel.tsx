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
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Label,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  toast,
} from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleGauge,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { type SubmitEvent, useState } from "react"
import {
  type AiLimitFormMeter,
  type AiLimitFormQuantity,
  aiLimitAmountInput,
  aiLimitSubjectChoices,
  aiLimitSubjectLabel,
  aiLimitUsagePercent,
  formatAiLimitQuantity,
  formatAiLimitQuantityExact,
  parseAiLimitFormQuantity,
} from "../lib/aiLimits"
import { UsageBar } from "./UsageBar"

type LimitStatus = GetAiLimitStatusResponse["items"][number]
type LimitPolicy = ListAiLimitPoliciesResponse["items"][number]
type LimitSubject = LimitPolicy["subject"]
type LimitSubjectType = LimitSubject["type"]
type LimitSubjectOptions = GetAiLimitSubjectOptionsResponse

export const AI_LIMIT_STATUS_QUERY = { query: { includeDisabled: "true" as const } }

export function AiLimitPanel() {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({ ...getAiLimitStatusOptions(AI_LIMIT_STATUS_QUERY), retry: false })
  const policyQuery = useQuery({
    ...listAiLimitPoliciesOptions(AI_LIMIT_STATUS_QUERY),
    retry: false,
  })
  const [dialogPolicy, setDialogPolicy] = useState<LimitPolicy | "new" | null>(null)

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAiLimitStatusQueryKey(AI_LIMIT_STATUS_QUERY) }),
      queryClient.invalidateQueries({
        queryKey: listAiLimitPoliciesQueryKey(AI_LIMIT_STATUS_QUERY),
      }),
    ])
  }

  const createPolicy = useMutation({
    ...createAiLimitPolicyMutation(),
    onSuccess: async () => {
      setDialogPolicy(null)
      toast.success("AI usage limit created.")
      await invalidate()
    },
    onError: (error) => toast.error(aiLimitErrorMessage(error, "Could not create the limit.")),
  })
  const updatePolicy = useMutation({
    ...updateAiLimitPolicyMutation(),
    onSuccess: async () => {
      setDialogPolicy(null)
      toast.success("AI usage limit updated.")
      await invalidate()
    },
    onError: (error) => toast.error(aiLimitErrorMessage(error, "Could not update the limit.")),
  })
  const deletePolicy = useMutation({
    ...deleteAiLimitPolicyMutation(),
    onSuccess: async () => {
      toast.success("AI usage limit deleted.")
      await invalidate()
    },
    onError: (error) => toast.error(aiLimitErrorMessage(error, "Could not delete the limit.")),
  })

  const statusData = statusQuery.data as GetAiLimitStatusResponse | undefined
  const policyData = policyQuery.data as ListAiLimitPoliciesResponse | undefined
  const canManage = policyData?.capabilities.manage ?? statusData?.capabilities.manage ?? false
  const subjectOptionsQuery = useQuery({
    ...getAiLimitSubjectOptionsOptions(),
    enabled: canManage,
    retry: false,
  })
  const subjectOptions = subjectOptionsQuery.data as LimitSubjectOptions | undefined
  const statuses = statusData?.items ?? []
  const statusByPolicyId = new Map(statuses.map((status) => [status.policy.id, status]))
  const policies = policyData?.items ?? statuses.map((status) => status.policy)
  const activePolicyCount = policies.filter((policy) => policy.enabled).length
  const mutationPending = createPolicy.isPending || updatePolicy.isPending || deletePolicy.isPending

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="grid-cols-[1fr_auto] gap-x-4 border-b py-5">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg">
            <CircleGauge className="size-4" />
            Monthly usage limits
          </CardTitle>
          <CardDescription>
            {statuses[0]
              ? `${formatLimitPeriod(statuses[0].period.start, statuses[0].period.end)} · ${activePolicyCount.toLocaleString()} active ${activePolicyCount === 1 ? "limit" : "limits"}`
              : "Limits reset at the start of each UTC calendar month."}
          </CardDescription>
          <p className="text-xs text-muted-foreground">
            Current-month limits are not affected by the analytics filters below.
          </p>
        </div>
        <CardAction>
          {canManage ? (
            <Button size="sm" onClick={() => setDialogPolicy("new")}>
              <Plus className="size-4" />
              Add limit
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {statusQuery.isLoading && policyQuery.isLoading ? (
          <div className="flex min-h-28 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading limits…
          </div>
        ) : !statusData && !policyData ? (
          <Alert variant="destructive" className="m-5 w-auto">
            <TriangleAlert />
            <AlertDescription>
              {aiLimitErrorMessage(
                policyQuery.error ?? statusQuery.error,
                "AI limit status is unavailable. Check limit storage and your project grant."
              )}
            </AlertDescription>
          </Alert>
        ) : policies.length === 0 ? (
          <div className="m-5 rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="text-sm font-medium">No monthly limits configured</p>
            <p className="mt-1 text-sm text-muted-foreground">
              AI calls are still accounted for, but no aggregate limit is currently enforced.
            </p>
            {canManage ? (
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                onClick={() => setDialogPolicy("new")}
              >
                <Plus className="size-4" />
                Add the first limit
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="divide-y">
            {policies.map((policy) => {
              const status = statusByPolicyId.get(policy.id)
              const actions = {
                canManage,
                subjectOptions,
                mutationPending,
                onEdit: () => setDialogPolicy(policy),
                onToggle: () =>
                  updatePolicy.mutate({
                    path: { limitId: policy.id },
                    body: { enabled: !policy.enabled },
                  }),
                onDelete: () => deletePolicy.mutate({ path: { limitId: policy.id } }),
              }
              return status ? (
                <AiLimitStatusRow key={policy.id} status={status} {...actions} />
              ) : (
                <AiLimitPolicyRow key={policy.id} policy={policy} {...actions} />
              )
            })}
          </div>
        )}
      </CardContent>

      {dialogPolicy !== null ? (
        <AiLimitPolicyDialog
          key={dialogPolicy === "new" ? "new" : dialogPolicy.id}
          policy={dialogPolicy === "new" ? undefined : dialogPolicy}
          subjectOptions={subjectOptions}
          subjectOptionsLoading={subjectOptionsQuery.isLoading}
          subjectOptionsError={subjectOptionsQuery.error}
          pending={createPolicy.isPending || updatePolicy.isPending}
          error={createPolicy.error ?? updatePolicy.error}
          onClose={() => {
            setDialogPolicy(null)
            createPolicy.reset()
            updatePolicy.reset()
          }}
          onCreate={(input) => createPolicy.mutate({ body: input })}
          onUpdate={(policyId, input) =>
            updatePolicy.mutate({ path: { limitId: policyId }, body: input })
          }
        />
      ) : null}
    </Card>
  )
}

function AiLimitStatusRow({
  status,
  canManage,
  subjectOptions,
  mutationPending,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly status: LimitStatus
  readonly canManage: boolean
  readonly subjectOptions?: LimitSubjectOptions
  readonly mutationPending: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
}) {
  const percent = aiLimitUsagePercent({
    limit: status.policy.limit,
    actual: status.consumption.actual,
    reserved: status.consumption.reserved,
    unknown: status.consumption.unknown,
  })
  const color = status.exhausted
    ? "red"
    : status.accountingStatus === "unavailable" || quantityIsPositive(status.consumption.unknown)
      ? "amber"
      : percent >= 80
        ? "amber"
        : "blue"

  const hasUnknown = quantityIsPositive(status.consumption.unknown)
  const hasReserved = quantityIsPositive(status.consumption.reserved)
  const percentLabel = formatAiLimitPercent(percent, committedIsPositive(status))
  const subjectLabel = aiLimitSubjectLabel(status.policy.subject, subjectOptions)

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="grid items-start gap-4 md:grid-cols-[minmax(10rem,0.8fr)_minmax(18rem,2fr)_auto]">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium">{subjectLabel}</p>
          <p className="text-xs text-muted-foreground">{meterLabel(status.policy.limit.meter)}</p>
        </div>

        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 text-sm font-medium tabular-nums">
              <span title={formatAiLimitQuantityExact(status.consumption.actual)}>
                {formatAiLimitQuantity(status.consumption.actual)}
              </span>{" "}
              <span className="font-normal text-muted-foreground">
                of {formatAiLimitQuantity(status.policy.limit)}
              </span>
            </p>
            <p className="text-xs font-medium tabular-nums">{percentLabel} used</p>
          </div>
          <UsageBar
            value={percent}
            color={color}
            ariaLabel={`${subjectLabel} monthly ${meterLabel(status.policy.limit.meter).toLowerCase()} usage`}
            valueText={`${percentLabel} used`}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span title={formatAiLimitQuantityExact(status.consumption.remaining)}>
              {formatAiLimitQuantity(status.consumption.remaining)} remaining
            </span>
            {hasReserved ? (
              <span title={formatAiLimitQuantityExact(status.consumption.reserved)}>
                {formatAiLimitQuantity(status.consumption.reserved)} reserved
              </span>
            ) : null}
            {hasUnknown ? (
              <span title={formatAiLimitQuantityExact(status.consumption.unknown)}>
                {formatAiLimitQuantity(status.consumption.unknown)} held for unknown outcomes
              </span>
            ) : null}
            <span>Resets {formatReset(status.period.resetAt)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 md:justify-end">
          <div className="flex flex-wrap justify-end gap-1.5">
            {!status.policy.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
            {status.exhausted && status.policy.enabled ? (
              <Badge variant="destructive">Exhausted</Badge>
            ) : null}
            {status.accountingStatus === "unavailable" ? (
              <Badge
                variant="outline"
                className="border-amber-500/50 text-amber-700 dark:text-amber-300"
              >
                Accounting unavailable
              </Badge>
            ) : null}
            {status.orphaned ? <Badge variant="outline">Orphaned group</Badge> : null}
            {status.policy.enabled &&
            !status.exhausted &&
            status.accountingStatus !== "unavailable" ? (
              <Badge variant="outline">Active</Badge>
            ) : null}
          </div>
          <AiLimitPolicyActions
            policy={status.policy}
            subjectLabel={subjectLabel}
            canManage={canManage}
            mutationPending={mutationPending}
            onEdit={onEdit}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        </div>
      </div>

      {status.accountingStatus === "unavailable" ? (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          This meter has incomplete accounting. Enforcement fails closed until every applicable
          ledger record can be measured safely.
        </p>
      ) : hasUnknown ? (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          At least one provider outcome is unknown, so its reserved capacity remains held.
        </p>
      ) : null}
      {status.orphaned ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          This group is no longer registered. Restore the group or delete this policy; immutable
          historical attribution is retained either way.
        </p>
      ) : null}
    </div>
  )
}

function AiLimitPolicyRow({
  policy,
  canManage,
  subjectOptions,
  mutationPending,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly policy: LimitPolicy
  readonly canManage: boolean
  readonly subjectOptions?: LimitSubjectOptions
  readonly mutationPending: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
}) {
  const subjectLabel = aiLimitSubjectLabel(policy.subject, subjectOptions)
  return (
    <div className="grid items-center gap-4 px-5 py-4 md:grid-cols-[minmax(10rem,0.8fr)_minmax(18rem,2fr)_auto]">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-medium">{subjectLabel}</p>
        <p className="text-xs text-muted-foreground">{meterLabel(policy.limit.meter)}</p>
      </div>
      <div>
        <p className="text-sm font-medium tabular-nums">
          {formatAiLimitQuantity(policy.limit)} monthly limit
        </p>
        <p className="text-xs text-muted-foreground">Usage requires the AI usage observe grant.</p>
      </div>
      <div className="flex items-center justify-between gap-2 md:justify-end">
        <Badge variant={policy.enabled ? "outline" : "secondary"}>
          {policy.enabled ? "Active" : "Disabled"}
        </Badge>
        <AiLimitPolicyActions
          policy={policy}
          subjectLabel={subjectLabel}
          canManage={canManage}
          mutationPending={mutationPending}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function AiLimitPolicyActions({
  policy,
  subjectLabel,
  canManage,
  mutationPending,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly policy: LimitPolicy
  readonly subjectLabel: string
  readonly canManage: boolean
  readonly mutationPending: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!canManage) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${subjectLabel} ${meterLabel(policy.limit.meter).toLowerCase()}`}
            disabled={mutationPending}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            Edit limit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggle}>
            {policy.enabled ? "Disable limit" : "Enable limit"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            Delete limit
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this AI usage limit?</AlertDialogTitle>
            <AlertDialogDescription>
              Current-period accounting is preserved. Deleting the policy only stops it from
              enforcing future model calls.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Delete limit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AiLimitPolicyDialog({
  policy,
  subjectOptions,
  subjectOptionsLoading,
  subjectOptionsError,
  pending,
  error,
  onClose,
  onCreate,
  onUpdate,
}: {
  readonly policy?: LimitPolicy
  readonly subjectOptions?: LimitSubjectOptions
  readonly subjectOptionsLoading: boolean
  readonly subjectOptionsError: unknown
  readonly pending: boolean
  readonly error: unknown
  readonly onClose: () => void
  readonly onCreate: (input: {
    subject: LimitSubject
    limit: AiLimitFormQuantity
    enabled: boolean
  }) => void
  readonly onUpdate: (
    policyId: string,
    input: { limit: AiLimitFormQuantity; enabled: boolean }
  ) => void
}) {
  const [subject, setSubject] = useState<LimitSubject>(policy?.subject ?? { type: "project" })
  const [meter, setMeter] = useState<AiLimitFormMeter>(
    policy?.limit.meter ?? "cost.catalogEstimated"
  )
  const [amount, setAmount] = useState(policy ? aiLimitAmountInput(policy.limit) : "")
  const currency =
    policy?.limit.meter === "cost.catalogEstimated" ? policy.limit.amount.currency : "USD"
  const [enabled, setEnabled] = useState(policy?.enabled ?? true)
  const [validationError, setValidationError] = useState<string>()
  const subjectChoices = limitSubjectFormChoices(subjectOptions, policy?.subject)
  const directoryError =
    policy === undefined && subject.type !== "project" ? subjectOptionsError : undefined

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = parseAiLimitFormQuantity(meter, amount, currency)
    if (!parsed.ok) {
      setValidationError(parsed.error)
      return
    }
    if (policy) {
      onUpdate(policy.id, { limit: parsed.quantity, enabled })
      return
    }
    onCreate({ subject, limit: parsed.quantity, enabled: true })
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{policy ? "Edit AI usage limit" : "Add AI usage limit"}</DialogTitle>
            <DialogDescription>
              Limits apply to every matching subject and reset on the UTC calendar month.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-limit-subject">Applies to</Label>
              <Combobox
                id="ai-limit-subject"
                value={limitSubjectFormValue(subject)}
                options={subjectChoices}
                onValueChange={(value) => {
                  setSubject(parseLimitSubjectFormValue(value))
                  setValidationError(undefined)
                }}
                disabled={policy !== undefined}
                placeholder={
                  subjectOptionsLoading ? "Loading project subjects…" : "Select a subject"
                }
                searchPlaceholder="Search projects, groups, users, or service accounts…"
                emptyLabel="No matching project subject found."
                className="bg-white dark:bg-input/30"
              />
              <p className="text-xs text-muted-foreground">
                Choose the project, group, user, or service account this limit controls.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Meter</Label>
                <ToggleGroup
                  type="single"
                  value={meter}
                  onValueChange={(value) => {
                    if (!value || policy !== undefined) return
                    setMeter(value as AiLimitFormMeter)
                    setAmount("")
                    setValidationError(undefined)
                  }}
                  variant="outline"
                  spacing={0}
                  className="w-full bg-white dark:bg-input/30"
                >
                  <ToggleGroupItem
                    value="cost.catalogEstimated"
                    disabled={policy !== undefined}
                    className="flex-1"
                  >
                    Cost
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="tokens.total"
                    disabled={policy !== undefined}
                    className="flex-1"
                  >
                    Tokens
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-limit-amount">
                  {meter === "cost.catalogEstimated"
                    ? `Monthly cost limit (${currency})`
                    : "Monthly token limit"}
                </Label>
                <div className="flex gap-2">
                  {meter === "cost.catalogEstimated" ? (
                    <div className="flex h-9 w-20 shrink-0 items-center rounded-md border bg-white px-3 text-sm dark:bg-input/30">
                      {currency}
                    </div>
                  ) : null}
                  <Input
                    id="ai-limit-amount"
                    className="bg-white dark:bg-input/30"
                    inputMode={meter === "tokens.total" ? "numeric" : "decimal"}
                    placeholder={meter === "tokens.total" ? "1000000" : "100.00"}
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value)
                      setValidationError(undefined)
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {policy ? (
            <div className="flex items-center justify-between rounded-lg border bg-white p-3 dark:bg-input/20">
              <div>
                <Label htmlFor="ai-limit-enabled">Enforce this limit</Label>
                <p className="text-xs text-muted-foreground">
                  Disabled limits retain their history.
                </p>
              </div>
              <Switch id="ai-limit-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          ) : null}

          {validationError || error || directoryError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>
                {validationError ??
                  aiLimitErrorMessage(
                    error ?? directoryError,
                    directoryError
                      ? "Could not load selectable project subjects."
                      : "Could not save the limit."
                  )}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="bg-white dark:bg-input/30"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {policy ? "Save changes" : "Add limit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function quantityIsPositive(quantity: AiLimitFormQuantity): boolean {
  return quantity.meter === "tokens.total"
    ? quantity.amount > 0
    : BigInt(quantity.amount.amountNanos) > 0n
}

function committedIsPositive(status: LimitStatus): boolean {
  return (
    quantityIsPositive(status.consumption.actual) ||
    quantityIsPositive(status.consumption.reserved) ||
    quantityIsPositive(status.consumption.unknown)
  )
}

function formatAiLimitPercent(percent: number, hasUsage: boolean): string {
  if (hasUsage && percent < 0.01) return "<0.01%"
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

function limitSubjectFormChoices(
  options: LimitSubjectOptions | undefined,
  selected?: LimitSubject
) {
  const choices = [
    { value: "project", label: "Current project", description: "Project" },
    ...(["group", "user", "serviceAccount"] as const).flatMap((type) =>
      aiLimitSubjectChoices(options, type).map((choice) => ({
        ...choice,
        value: limitSubjectFormValue({ type, id: choice.value }),
        description: [subjectTypeLabel(type), choice.description].filter(Boolean).join(" · "),
      }))
    ),
  ]
  if (selected && !choices.some((choice) => choice.value === limitSubjectFormValue(selected))) {
    choices.push({
      value: limitSubjectFormValue(selected),
      label: aiLimitSubjectLabel(selected, options),
      description: selected.type === "project" ? "Project" : subjectTypeLabel(selected.type),
    })
  }
  return choices
}

function limitSubjectFormValue(subject: LimitSubject): string {
  return subject.type === "project" ? "project" : `${subject.type}:${subject.id}`
}

function parseLimitSubjectFormValue(value: string): LimitSubject {
  if (value === "project") return { type: "project" }
  const separator = value.indexOf(":")
  const type = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (id && (type === "group" || type === "user" || type === "serviceAccount")) {
    return { type, id }
  }
  throw new Error(`[SixbAtlas] Invalid AI limit subject selection: ${value}`)
}

function subjectTypeLabel(subject: Exclude<LimitSubjectType, "project">): string {
  if (subject === "serviceAccount") return "Service account"
  return subject === "group" ? "Group" : "User"
}

function meterLabel(meter: AiLimitFormMeter): string {
  return meter === "tokens.total" ? "Token limit" : "Cost limit"
}

function formatLimitPeriod(start: string, end: string): string {
  const startLabel = new Date(start).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  const endLabel = new Date(end).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
  return `Current period: ${startLabel} – ${endLabel} UTC`
}

function formatReset(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })
}

function aiLimitErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const message = (error as { error?: unknown }).error
    if (typeof message === "string" && message.length > 0) return message
  }
  return error instanceof Error && error.message ? error.message : fallback
}
