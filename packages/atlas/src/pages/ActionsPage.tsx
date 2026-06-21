import type {
  GetActionRunResponse,
  ListActionRunsResponse,
  ListActionsResponse,
} from "@sixb/client"
import {
  getActionRunQueryKey,
  listActionRunsOptions,
  listActionRunsQueryKey,
  listActionsOptions,
  listActionsQueryKey,
  listObjectsOptions,
  requestActionMutation,
} from "@sixb/client/hooks"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Play, SquareActivity } from "lucide-react"
import { type SyntheticEvent, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { formatDate, formatRelativeTime } from "../features/workflows/utils/workflows"
import {
  type ActionRequestPayload,
  buildActionParams,
  describeActionParamInput,
} from "../lib/actions/params"

type ActionCatalogItem = ListActionsResponse[number]
type ActionRunSummary = ListActionRunsResponse["runs"][number]
type ActionRunStatus = ActionRunSummary["status"]
type ActionCommitDiff = NonNullable<GetActionRunResponse["commit"]>["diff"]

type ActionsPageTab = "actions" | "runs"

const actionRunStatusLabels: Record<ActionRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

const actionRunStatusClasses: Record<ActionRunStatus, string> = {
  queued:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  running:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  succeeded:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  cancelled:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300",
}

export function ActionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: ActionsPageTab = searchParams.get("tab") === "runs" ? "runs" : "actions"

  const handleTabChange = (value: string) => {
    const nextTab: ActionsPageTab = value === "runs" ? "runs" : "actions"
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set("tab", nextTab)
      return params
    })
  }

  return (
    <PageFrame
      eyebrow="Atlas"
      title="Actions"
      description="Request ontology actions and inspect their durable execution history."
    >
      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-4">
        <TabsList variant="line" className="border-b border-border">
          <TabsTrigger value="actions">Actions</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="actions" className="mt-0">
          <ActionDefinitionsTab />
        </TabsContent>
        <TabsContent value="runs" className="mt-0">
          <ActionRunHistoryTab />
        </TabsContent>
      </Tabs>
    </PageFrame>
  )
}

function ActionDefinitionsTab() {
  const actionsQuery = useQuery(listActionsOptions())
  const actions = actionsQuery.data ?? []

  if (actionsQuery.isLoading) {
    return <LoadingPage label="Loading actions..." />
  }

  if (actionsQuery.isError) {
    return <ErrorPage title="Actions unavailable" description="Could not load action metadata." />
  }

  return (
    <section className="space-y-3">
      {actions.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SquareActivity className="size-12 stroke-1" />}
            title="No actions registered"
            description="Define actions to request ontology mutations from Atlas."
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {actions.map((action) => (
            <ActionDefinitionCard key={action.id} action={action} />
          ))}
        </div>
      )}
    </section>
  )
}

function ActionDefinitionCard({ action }: { action: ActionCatalogItem }) {
  const paramCount = action.params.length

  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="truncate font-medium text-foreground">{action.id}</h3>
            <p className="text-sm text-muted-foreground">
              {action.objectTypeId ? `Object action on ${action.objectTypeId}` : "Global action"} ·{" "}
              {paramCount} {paramCount === 1 ? "param" : "params"}
            </p>
          </div>
          <ActionRequestDialog action={action} />
        </div>

        {action.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{action.description}</p>
        ) : null}

        <div className="mt-auto flex flex-wrap gap-2">
          <PhaseBadge active={action.phases.writeback}>writeback</PhaseBadge>
          <PhaseBadge active={action.phases.edits}>edits</PhaseBadge>
          <PhaseBadge active={action.phases.effects}>effects</PhaseBadge>
        </div>
      </CardContent>
    </Card>
  )
}

function PhaseBadge({ active, children }: { active: boolean; children: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-md font-mono text-[10px]",
        active ? "border-border bg-muted text-foreground" : "text-muted-foreground opacity-60"
      )}
    >
      {children}
    </Badge>
  )
}

function ActionRunHistoryTab() {
  const runsQuery = useQuery({
    ...listActionRunsOptions({ query: { limit: "50", order: "desc" } }),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running")
        ? 2000
        : false,
  })
  const runs = runsQuery.data?.runs ?? []

  if (runsQuery.isLoading) {
    return <LoadingPage label="Loading action runs..." />
  }

  if (runsQuery.isError) {
    return (
      <ErrorPage title="Action runs unavailable" description="Could not load action run history." />
    )
  }

  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<SquareActivity className="size-12 stroke-1" />}
          title="No action runs"
          description="Requested actions will appear here."
        />
      </Card>
    )
  }

  return <ActionRunTable runs={runs} />
}

export function ActionRunTable({ runs }: { runs: readonly ActionRunSummary[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Subject</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Queued</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="font-mono text-xs">
                <Link to={`/actions/runs/${run.id}`} className="underline-offset-4 hover:underline">
                  {run.id}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {run.actionId}
              </TableCell>
              <TableCell>
                <ActionRunStatusBadge status={run.status} />
              </TableCell>
              <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                {formatSubject(run.subject)}
              </TableCell>
              <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                {formatRelativeTime(run.queuedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

export function ActionRunStatusBadge({ status }: { status: ActionRunStatus }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-md", actionRunStatusClasses[status])}>
      {status === "succeeded" ? <CheckCircle2 className="h-3 w-3" /> : null}
      {status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {actionRunStatusLabels[status]}
    </Badge>
  )
}

function ActionRequestDialog({
  action,
  subject,
}: {
  action: ActionCatalogItem
  subject?: { kind: "object"; objectTypeId: string; primaryId: string }
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [subjectPrimaryId, setSubjectPrimaryId] = useState(subject?.primaryId ?? "")
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const requestAction = useMutation({
    ...requestActionMutation(),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listActionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listActionRunsQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getActionRunQueryKey({ path: { runId: response.runId } }),
        }),
      ])
      setOpen(false)
      navigate(`/actions/runs/${response.runId}`)
    },
  })

  const apiErrorMessage = errorToMessage(requestAction.error)
  const defaultSubject =
    subject ??
    (action.objectTypeId && subjectPrimaryId
      ? { kind: "object" as const, objectTypeId: action.objectTypeId, primaryId: subjectPrimaryId }
      : undefined)

  function handleSubjectPrimaryIdChange(value: string) {
    setSubjectPrimaryId(value)
    setFieldErrors(({ __subject: _subject, ...rest }) => rest)
    requestAction.reset()
  }

  function handleParamChange(paramId: string, value: string) {
    setValues((current) => ({ ...current, [paramId]: value }))
    setFieldErrors(({ [paramId]: _param, ...rest }) => rest)
    requestAction.reset()
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    setValues({})
    setFieldErrors({})
    requestAction.reset()
    setSubjectPrimaryId(subject?.primaryId ?? "")
  }

  function buildRequestPayload(options: { updateErrors: boolean }): ActionRequestPayload | null {
    const paramsResult = buildActionParams(action, values)
    const errors = { ...paramsResult.errors }
    if (action.objectTypeId && !defaultSubject) {
      errors.__subject = "Target object id is required."
    }
    if (options.updateErrors) {
      setFieldErrors(errors)
    }
    if (Object.keys(errors).length > 0) {
      return null
    }
    return {
      path: { actionId: action.id },
      body: {
        ...(defaultSubject ? { subject: defaultSubject } : {}),
        params: paramsResult.params,
      },
    }
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    requestAction.reset()
    const payload = buildRequestPayload({ updateErrors: true })
    if (!payload) return
    requestAction.mutate(payload)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <Play className="h-4 w-4" />
          Request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Request action</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{action.id}</span>
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <section className="max-h-[min(33rem,calc(100vh-17rem))] space-y-4 overflow-y-auto pr-1">
            {action.objectTypeId ? (
              <div className="space-y-1.5">
                <Label htmlFor={`action-${action.id}-subject`} className="text-xs">
                  Target {action.objectTypeId} id
                </Label>
                <Input
                  id={`action-${action.id}-subject`}
                  value={subjectPrimaryId}
                  onChange={(event) => handleSubjectPrimaryIdChange(event.target.value)}
                  disabled={Boolean(subject)}
                  required
                />
                {fieldErrors.__subject ? (
                  <p className="text-xs text-destructive">{fieldErrors.__subject}</p>
                ) : null}
              </div>
            ) : null}

            <ActionParamFields
              action={action}
              values={values}
              errors={fieldErrors}
              onChange={handleParamChange}
            />
          </section>

          {apiErrorMessage ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Action request failed</AlertTitle>
              <AlertDescription>{apiErrorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={requestAction.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={requestAction.isPending}>
              {requestAction.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Request action
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ActionParamFields({
  action,
  values,
  errors,
  onChange,
}: {
  action: ActionCatalogItem
  values: Record<string, string>
  errors: Record<string, string>
  onChange: (paramId: string, value: string) => void
}) {
  if (action.params.length === 0) {
    return <p className="text-sm text-muted-foreground">This action does not require params.</p>
  }

  return (
    <div className="space-y-3">
      {action.params.map((param) => {
        const input = describeActionParamInput(param.schema)
        const value = values[param.id] ?? ""
        const fieldId = `action-${action.id}-${param.id}`

        return (
          <div key={param.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={fieldId} className="text-xs">
                {param.id}
              </Label>
              {param.required ? (
                <Badge variant="outline" className="h-4 px-1 py-0 text-[8px] uppercase">
                  Required
                </Badge>
              ) : null}
            </div>
            {param.description ? (
              <p className="text-[11px] text-muted-foreground">{param.description}</p>
            ) : null}

            {input.kind === "objectRef" ? (
              <ObjectRefField
                objectTypeId={input.objectTypeId}
                value={value}
                onChange={(next) => onChange(param.id, next)}
                fieldId={fieldId}
              />
            ) : input.kind === "enum" ? (
              <Select value={value} onValueChange={(next) => onChange(param.id, next)}>
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {input.values.map((option) => (
                    <SelectItem key={String(option)} value={String(option)}>
                      {String(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : input.kind === "boolean" ? (
              <Select value={value} onValueChange={(next) => onChange(param.id, next)}>
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            ) : input.kind === "json" ? (
              <Textarea
                id={fieldId}
                value={value}
                onChange={(event) => onChange(param.id, event.target.value)}
                required={param.required}
                placeholder='{"objectTypeId":"Customer","primaryId":"cus_1"}'
                className="min-h-24 font-mono text-xs"
              />
            ) : (
              <Input
                id={fieldId}
                type={input.kind === "number" ? "number" : "text"}
                value={value}
                onChange={(event) => onChange(param.id, event.target.value)}
                required={param.required}
              />
            )}

            {errors[param.id] ? (
              <p className="text-xs text-destructive">{errors[param.id]}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function ObjectRefField({
  objectTypeId,
  value,
  onChange,
  fieldId,
}: {
  objectTypeId: string
  value: string
  onChange: (value: string) => void
  fieldId: string
}) {
  const objectsQuery = useQuery(
    listObjectsOptions({
      query: { objectTypeId, limit: "100", orderBy: "primaryId", order: "asc" },
    })
  )
  const objects = objectsQuery.data ?? []

  if (objectsQuery.isError) {
    return (
      <Input
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`${objectTypeId} id`}
      />
    )
  }

  const isEmpty = !objectsQuery.isLoading && objects.length === 0

  return (
    <Select value={value} onValueChange={onChange} disabled={objectsQuery.isLoading || isEmpty}>
      <SelectTrigger id={fieldId} className="w-full">
        <SelectValue
          placeholder={
            objectsQuery.isLoading
              ? "Loading..."
              : isEmpty
                ? `No ${objectTypeId} found`
                : `Select ${objectTypeId}...`
          }
        />
      </SelectTrigger>
      <SelectContent>
        {objects.map((object) => (
          <SelectItem key={object.primaryId} value={object.primaryId}>
            {objectRefLabel(object)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function objectRefLabel(object: { name: string; primaryId: string }): string {
  return object.name && object.name !== object.primaryId
    ? `${object.name} · ${object.primaryId}`
    : object.primaryId
}

type DiffOperation = ActionCommitDiff["objects"][number]["operation"]

const diffOperationClasses: Record<DiffOperation, string> = {
  create:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  update:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  delete:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
}

function DiffOperationBadge({ operation }: { operation: DiffOperation }) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-md font-mono text-[10px]", diffOperationClasses[operation])}
    >
      {operation}
    </Badge>
  )
}

function DiffGroup({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h4 className="text-sm font-medium text-foreground">{label}</h4>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function ObjectRef({ objectTypeId, primaryId }: { objectTypeId: string; primaryId: string }) {
  return (
    <span className="font-mono text-sm">
      <span className="text-muted-foreground">{objectTypeId}:</span>
      <span className="text-foreground">{primaryId}</span>
    </span>
  )
}

export function ActionRunDiffSummary({ diff }: { diff: ActionCommitDiff }) {
  const objectCount = diff.objects.length
  const linkCount = diff.links.length

  if (objectCount === 0 && linkCount === 0) {
    return <p className="text-sm text-muted-foreground">No changes recorded.</p>
  }

  return (
    <div className="space-y-5">
      {objectCount > 0 ? (
        <DiffGroup label="Objects" count={objectCount}>
          {diff.objects.map((object) => (
            <div
              key={`${object.objectTypeId}:${object.primaryId}:${object.operation}`}
              className="space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <DiffOperationBadge operation={object.operation} />
                <ObjectRef objectTypeId={object.objectTypeId} primaryId={object.primaryId} />
              </div>
              {object.changedProperties.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {object.changedProperties.map((prop) => (
                    <span
                      key={prop}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {prop}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </DiffGroup>
      ) : null}

      {linkCount > 0 ? (
        <DiffGroup label="Links" count={linkCount}>
          {diff.links.map((link) => (
            <div
              key={`${link.source.objectTypeId}:${link.source.primaryId}:${link.linkId}:${link.target.objectTypeId}:${link.target.primaryId}:${link.operation}`}
              className="flex flex-wrap items-center gap-2"
            >
              <DiffOperationBadge operation={link.operation} />
              <span className="font-mono text-sm">
                <span className="text-foreground">
                  {link.source.objectTypeId}:{link.source.primaryId}
                </span>
                <span className="text-muted-foreground">.{link.linkId}</span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <ObjectRef
                objectTypeId={link.target.objectTypeId}
                primaryId={link.target.primaryId}
              />
            </div>
          ))}
        </DiffGroup>
      ) : null}
    </div>
  )
}

export function ActionRunMetaGrid({ run }: { run: ActionRunSummary }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Status" value={<ActionRunStatusBadge status={run.status} />} />
      <Metric label="Phase" value={run.phase ?? "Not started"} />
      <Metric label="Queued" value={formatDate(run.queuedAt)} />
      <Metric label="Subject" value={formatSubject(run.subject)} mono />
    </div>
  )
}

function Metric({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Card className="p-0">
      <CardContent className="space-y-1.5 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className={cn("break-words text-sm text-foreground", mono && "font-mono text-xs")}>
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

function formatSubject(subject: ActionRunSummary["subject"]): string {
  if (subject.kind === "none") {
    return "global"
  }
  return `${subject.objectTypeId}:${subject.primaryId}`
}

function errorToMessage(error: unknown): string | null {
  if (!error) return null
  if (isRecord(error) && typeof error.error === "string") return error.error
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Could not request action."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export { ActionRequestDialog, formatSubject }
