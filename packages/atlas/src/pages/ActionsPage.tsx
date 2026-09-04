import type { ListActionRunsResponse, ListActionsResponse } from "@sixb/client"
import {
  listActionRunsOptions,
  listActionsOptions,
  listObjectsInfiniteOptions,
  useActionRunMutation,
} from "@sixb/client/hooks"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Combobox,
  type ComboboxOption,
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  CheckCircle2,
  GitCommitHorizontal,
  Loader2,
  Play,
  Search,
  SquareActivity,
  X,
} from "lucide-react"
import {
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useState,
} from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { ActionParamNullControl } from "../components/ActionParamNullControl"
import { CollectionSearchInput } from "../components/CollectionPageHeader"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import {
  FileRefUploadField,
  parseFileRefFormValue,
  stringifyFileRefFormValue,
} from "../components/FileRefUploadField"
import { useActionLiveUpdates } from "../features/actions/hooks/useActionLiveUpdates"
import { formatDate, formatRelativeTime } from "../features/workflows/utils/workflows"
import {
  type ActionParamFormValue,
  type ActionParamFormValues,
  type ActionRequestPayload,
  buildActionParams,
  describeActionParamInput,
} from "../lib/actions/params"
import { humanizeIdentifier } from "../lib/labels"

type ActionCatalogItem = ListActionsResponse[number]
type ActionRunSummary = ListActionRunsResponse["runs"][number]
type ActionRunStatus = ActionRunSummary["status"]

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
  useActionLiveUpdates()

  const handleTabChange = (value: string) => {
    const nextTab: ActionsPageTab = value === "runs" ? "runs" : "actions"
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set("tab", nextTab)
      return params
    })
  }

  return (
    <PageFrame title="Actions" headerDivider={false}>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-4">
        <TabsList variant="line">
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
  const runsQuery = useQuery({
    ...listActionRunsOptions({ query: { limit: "50", order: "desc" } }),
  })
  const actions = actionsQuery.data ?? []
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get("q") ?? ""
  const scope =
    searchParams.get("scope") === "global"
      ? "global"
      : searchParams.get("scope") === "object"
        ? "object"
        : "all"
  const requestedType = searchParams.get("type") ?? "all"

  const objectTypes = useMemo(
    () =>
      Array.from(
        new Set(actions.flatMap((action) => (action.objectTypeId ? [action.objectTypeId] : [])))
      ).sort((left, right) => humanizeIdentifier(left).localeCompare(humanizeIdentifier(right))),
    [actions]
  )
  const objectType =
    scope !== "global" && objectTypes.includes(requestedType) ? requestedType : "all"
  const latestRunByAction = useMemo(() => {
    const latest = new Map<string, ActionRunSummary>()
    for (const run of runsQuery.data?.runs ?? []) {
      if (!latest.has(run.actionId)) latest.set(run.actionId, run)
    }
    return latest
  }, [runsQuery.data])
  const filteredActions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return actions.filter((action) => {
      if (scope === "global" && action.objectTypeId) return false
      if (scope === "object" && !action.objectTypeId) return false
      if (objectType !== "all" && action.objectTypeId !== objectType) return false
      if (!normalizedQuery) return true
      return [action.id, humanizeIdentifier(action.id), action.description, action.objectTypeId]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    })
  }, [actions, objectType, query, scope])
  const filtersActive = query.trim().length > 0 || scope !== "all" || objectType !== "all"

  const updateFilterParam = (key: "q" | "type", value: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (!value || value === "all") next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: key === "q" }
    )
  }

  const updateScope = (value: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value === "all") next.delete("scope")
        else next.set("scope", value)
        if (value === "global") next.delete("type")
        return next
      },
      { replace: false }
    )
  }

  if (actionsQuery.isLoading) {
    return <LoadingPage label="Loading actions..." />
  }

  if (actionsQuery.isError) {
    return <ErrorPage title="Actions unavailable" description="Could not load action metadata." />
  }

  return (
    <section className="space-y-4">
      {actions.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SquareActivity className="size-12 stroke-1" />}
            title="No actions registered"
            description="Define actions to request ontology mutations from Atlas."
          />
        </Card>
      ) : (
        <>
          <div className="sticky top-0 z-20 flex flex-col gap-1.5 bg-background/92 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82 lg:flex-row lg:items-center">
            <CollectionSearchInput
              value={query}
              onChange={(value) => updateFilterParam("q", value)}
              placeholder="Search actions…"
            />
            <Select value={scope} onValueChange={updateScope}>
              <SelectTrigger className="h-9 w-full bg-white lg:w-36" aria-label="Action scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="object">Object actions</SelectItem>
                <SelectItem value="global">Global actions</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={scope === "global" ? "all" : objectType}
              disabled={scope === "global"}
              onValueChange={(value) => updateFilterParam("type", value)}
            >
              <SelectTrigger
                className="h-9 w-full bg-white lg:w-48"
                aria-label="Target object type"
              >
                <SelectValue placeholder="All object types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All object types</SelectItem>
                {objectTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {humanizeIdentifier(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filtersActive ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="size-9 shrink-0 bg-white"
                aria-label="Clear action filters"
                title="Clear action filters"
                onClick={() => {
                  setSearchParams((previous) => {
                    const next = new URLSearchParams(previous)
                    next.delete("q")
                    next.delete("scope")
                    next.delete("type")
                    return next
                  })
                }}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>

          {filtersActive ? (
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-medium text-foreground">{filteredActions.length}</span>{" "}
              of {actions.length} actions
            </p>
          ) : null}

          {filteredActions.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {filteredActions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  latestRun={latestRunByAction.get(action.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<Search className="size-10 stroke-1" />}
                title="No matching actions"
                description="Try another name, scope, or object type."
              />
            </Card>
          )}
        </>
      )}
    </section>
  )
}

function ActionCard({
  action,
  latestRun,
}: {
  action: ActionCatalogItem
  latestRun?: ActionRunSummary
}) {
  const paramCount = action.params.length
  const scopeLabel = action.objectTypeId
    ? `${humanizeIdentifier(action.objectTypeId)} action`
    : "Global action"

  return (
    <ActionRequestDialog
      action={action}
      trigger={
        <button
          type="button"
          className="group flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left text-card-foreground outline-none transition-colors hover:border-[var(--atlas-border-hover)] hover:bg-[var(--atlas-surface-hover)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="flex min-w-0 items-center gap-3 p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--atlas-panel-subtle)] text-muted-foreground">
              <GitCommitHorizontal className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {humanizeIdentifier(action.id)}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {scopeLabel} · {paramCount} input {paramCount === 1 ? "field" : "fields"}
              </span>
            </span>
          </span>

          <span className="flex min-h-14 w-full items-center justify-between gap-3 border-t border-border px-4 py-3">
            {latestRun ? (
              <>
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  Latest run {formatRelativeTime(latestRun.queuedAt)}
                </span>
                <ActionRunStatusBadge status={latestRun.status} />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">No runs recorded</span>
            )}
          </span>
        </button>
      }
    />
  )
}

function ActionRunHistoryTab() {
  const runsQuery = useQuery({
    ...listActionRunsOptions({ query: { limit: "50", order: "desc" } }),
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
    <Card className="gap-0 overflow-hidden p-0">
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
  trigger,
}: {
  action: ActionCatalogItem
  subject?: { kind: "object"; objectTypeId: string; primaryId: string }
  trigger?: ReactElement
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<ActionParamFormValues>({})
  const [subjectPrimaryId, setSubjectPrimaryId] = useState(subject?.primaryId ?? "")
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pendingFileUploads, setPendingFileUploads] = useState<ReadonlySet<string>>(() => new Set())
  const requestAction = useActionRunMutation({
    invalidateOnCommit: true,
    onSuccess: (run) => {
      setOpen(false)
      navigate(`/actions/runs/${run.id}`)
    },
  })

  const apiErrorMessage = errorToMessage(requestAction.error)
  const hasPendingFileUploads = pendingFileUploads.size > 0
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

  function handleParamChange(paramId: string, value: ActionParamFormValue) {
    setValues((current) => ({ ...current, [paramId]: value }))
    setFieldErrors(({ [paramId]: _param, ...rest }) => rest)
    requestAction.reset()
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && hasPendingFileUploads) return

    setOpen(nextOpen)
    setValues({})
    setFieldErrors({})
    setPendingFileUploads(new Set())
    requestAction.reset()
    setSubjectPrimaryId(subject?.primaryId ?? "")
  }

  const handleFileUploadPendingChange = useCallback((paramId: string, pending: boolean) => {
    setPendingFileUploads((current) => {
      const hasParam = current.has(paramId)
      if (hasParam === pending) return current

      const next = new Set(current)
      if (pending) next.add(paramId)
      else next.delete(paramId)
      return next
    })
  }, [])

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
    if (hasPendingFileUploads) return
    requestAction.reset()
    const payload = buildRequestPayload({ updateErrors: true })
    if (!payload) return
    requestAction.mutate(payload)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" size="sm">
            <Play className="h-4 w-4" />
            Request
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Request action</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{action.id}</span>
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          {/* p-1 insets the fields so focus rings (drawn outside the input) aren't
              clipped by the scroll container's overflow. */}
          <section className="max-h-[min(33rem,calc(100vh-17rem))] space-y-4 overflow-y-auto p-1">
            {action.objectTypeId ? (
              <div className="space-y-1.5">
                <Label htmlFor={`action-${action.id}-subject`} className="text-xs">
                  Target {action.objectTypeId}
                </Label>
                <ObjectRefField
                  objectTypeId={action.objectTypeId}
                  value={subjectPrimaryId}
                  onChange={handleSubjectPrimaryIdChange}
                  fieldId={`action-${action.id}-subject`}
                  disabled={Boolean(subject)}
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
              pendingFileUploads={pendingFileUploads}
              onChange={handleParamChange}
              onFileUploadPendingChange={handleFileUploadPendingChange}
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
              disabled={requestAction.isPending || hasPendingFileUploads}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={requestAction.isPending || hasPendingFileUploads}>
              {requestAction.isPending || hasPendingFileUploads ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {hasPendingFileUploads
                ? "Uploading..."
                : requestAction.isPending
                  ? "Running action..."
                  : "Request action"}
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
  pendingFileUploads,
  onChange,
  onFileUploadPendingChange,
}: {
  action: ActionCatalogItem
  values: ActionParamFormValues
  errors: Record<string, string>
  pendingFileUploads: ReadonlySet<string>
  onChange: (paramId: string, value: ActionParamFormValue) => void
  onFileUploadPendingChange?: (paramId: string, pending: boolean) => void
}) {
  if (action.params.length === 0) {
    return <p className="text-sm text-muted-foreground">This action does not require params.</p>
  }

  return (
    <div className="space-y-3">
      {action.params.map((param) => {
        const input = describeActionParamInput(param.schema)
        const formValue = values[param.id]
        const isNull = formValue === null
        const value = typeof formValue === "string" ? formValue : ""
        const fieldId = `action-${action.id}-${param.id}`
        const fieldDisabled = isNull
        const fieldRequired = Boolean(param.required && !isNull)

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
              {param.nullable ? (
                <ActionParamNullControl
                  paramName={param.id}
                  isNull={isNull}
                  disabled={pendingFileUploads.has(param.id)}
                  onNullChange={(nextIsNull) => onChange(param.id, nextIsNull ? null : "")}
                />
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
                disabled={fieldDisabled}
              />
            ) : input.kind === "fileRef" ? (
              <FileRefUploadField
                key={`${param.id}:${isNull ? "null" : "value"}`}
                id={fieldId}
                value={parseFileRefFormValue(value)}
                onChange={(fileRef) =>
                  onChange(param.id, fileRef ? stringifyFileRefFormValue(fileRef) : "")
                }
                errorId={errors[param.id] ? `${fieldId}-error` : undefined}
                logicalPathPrefix={`actions/${action.id}/${param.id}`}
                disabled={fieldDisabled}
                onPendingChange={(pending) => onFileUploadPendingChange?.(param.id, pending)}
              />
            ) : input.kind === "enum" ? (
              <Select
                value={value}
                onValueChange={(next) => onChange(param.id, next)}
                required={fieldRequired}
                disabled={fieldDisabled}
              >
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
              <Select
                value={value}
                onValueChange={(next) => onChange(param.id, next)}
                required={fieldRequired}
                disabled={fieldDisabled}
              >
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
                required={fieldRequired}
                disabled={fieldDisabled}
                placeholder='{"objectTypeId":"Customer","primaryId":"cus_1"}'
                className="min-h-24 font-mono text-xs"
              />
            ) : (
              <Input
                id={fieldId}
                type={input.kind === "number" ? "number" : "text"}
                value={value}
                onChange={(event) => onChange(param.id, event.target.value)}
                required={fieldRequired}
                disabled={fieldDisabled}
              />
            )}

            {errors[param.id] ? (
              <p id={`${fieldId}-error`} className="text-xs text-destructive">
                {errors[param.id]}
              </p>
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
  disabled,
}: {
  objectTypeId: string
  value: string
  onChange: (value: string) => void
  fieldId: string
  disabled?: boolean
}) {
  const objectsQuery = useInfiniteQuery(
    listObjectsInfiniteOptions({
      query: { objectTypeId, limit: "50", orderBy: "primaryId", order: "asc" },
    })
  )

  const options = useMemo<ComboboxOption[]>(
    () =>
      (objectsQuery.data?.pages ?? []).flatMap((page) =>
        page.objects.map((object) => {
          const hasName = Boolean(object.name) && object.name !== object.primaryId
          return {
            value: object.primaryId,
            label: hasName ? object.name : object.primaryId,
            description: hasName ? object.primaryId : undefined,
          }
        })
      ),
    [objectsQuery.data]
  )

  if (objectsQuery.isError) {
    return (
      <Input
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`${objectTypeId} id`}
        disabled={disabled}
      />
    )
  }

  const isEmpty = !objectsQuery.isLoading && options.length === 0

  return (
    <Combobox
      id={fieldId}
      value={value}
      options={options}
      onValueChange={onChange}
      disabled={disabled || isEmpty}
      placeholder={
        objectsQuery.isLoading
          ? "Loading..."
          : isEmpty
            ? `No ${objectTypeId} found`
            : `Select ${objectTypeId}...`
      }
      searchPlaceholder={`Search ${objectTypeId}...`}
      emptyLabel={`No matching ${objectTypeId} found.`}
      hasMore={objectsQuery.hasNextPage}
      loadingMore={objectsQuery.isFetchingNextPage}
      onLoadMore={() => {
        void objectsQuery.fetchNextPage()
      }}
    />
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

function Metric({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <Card className="p-0">
      <CardContent className="space-y-1.5 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className={cn("wrap-break-word text-sm text-foreground", mono && "font-mono text-xs")}>
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
