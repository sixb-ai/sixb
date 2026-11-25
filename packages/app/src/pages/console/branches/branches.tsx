import type { ListBranchesResponse } from "@sixb/client"
import {
  deleteBranchMutation,
  listBranchesOptions,
  listBranchesQueryKey,
  openBranchMutation,
  refreshBranchMutation,
  signIntoBranchMutation,
  stopBranchMutation,
  useUser,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  GitFork,
  Info,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useCurrentUser } from "../../../session"
import { notify, SectionPage } from "../../section-page"
import {
  apiErrorMessage,
  CopyButton,
  IconTile,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  Pill,
  type Tone,
  useFormat,
  useLoadFailure,
} from "../../section-ui"
import { SkeletonBlock } from "../skeletons"
import { type BranchesMessages, useBranchesMessages } from "./messages"

export type Branch = ListBranchesResponse["branches"][number]
type Unavailable = NonNullable<ListBranchesResponse["unavailable"]>

/** What a branch is doing, in the words a person reads on its pill. */
export type BranchStatus = keyof BranchesMessages["status"]

/** Where a branch that is on its way up is: the step it is on. */
export type BranchStep = "preparing" | "copying" | "starting"

const STEPS: readonly BranchStep[] = ["preparing", "copying", "starting"]

/** How long a branch waits for a worker before the page says nobody has picked it up. */
const WORKER_WAIT_MS = 60_000

/** How often the list is read while a branch moves, and while none does. */
export const BRANCHES_POLL_MS = { moving: 2_000, settled: 15_000 } as const

/** The pill a branch shows: what a person can do with it now. */
export function branchStatus(branch: Branch): BranchStatus {
  if (branch.wanted === "deleted") return "deleting"
  if (branch.state === "failed") return "attention"
  if (branch.wanted === "stopped") return branch.state === "stopped" ? "stopped" : "stopping"
  if (refreshPending(branch)) return "refreshing"
  return branch.state === "ready" ? "ready" : "starting"
}

/** The step a branch on its way up is on, or null when it isn't on its way. */
export function branchStep(branch: Branch): BranchStep | null {
  const status = branchStatus(branch)
  if (status !== "starting" && status !== "refreshing") return null
  if (branch.state === "copying") return "copying"
  if (branch.state === "starting") return "starting"
  return "preparing"
}

/** Whether the list should be read again soon: something on it is changing. */
export function branchesPollInterval(branches: readonly Branch[] | undefined): number {
  const moving = branches?.some((branch) => {
    const status = branchStatus(branch)
    return status !== "ready" && status !== "stopped" && status !== "attention"
  })
  return moving ? BRANCHES_POLL_MS.moving : BRANCHES_POLL_MS.settled
}

/** What needs attention first, then the branches opened last. */
export function sortBranches(branches: readonly Branch[]): readonly Branch[] {
  return [...branches].sort(
    (left, right) =>
      Number(branchStatus(right) === "attention") - Number(branchStatus(left) === "attention") ||
      Date.parse(right.openedAt) - Date.parse(left.openedAt) ||
      left.name.localeCompare(right.name)
  )
}

/** A refresh was asked for after the copy the branch runs on. */
function refreshPending(branch: Branch): boolean {
  if (!branch.refreshRequestedAt) return false
  if (!branch.data) return true
  return Date.parse(branch.refreshRequestedAt) > Date.parse(branch.data.takenAt)
}

const statusTones: Record<BranchStatus, Tone> = {
  ready: "ok",
  starting: "info",
  refreshing: "info",
  stopping: "muted",
  stopped: "muted",
  attention: "error",
  deleting: "muted",
}

type Confirm = { readonly kind: "refresh" | "delete"; readonly name: string }

/**
 * Console › Branches: the git branches production runs next to itself, each on a copy of what its
 * creator sees. Open one in a new tab, signed in through production; refresh, stop or delete it.
 */
export function ConsoleBranchesPage() {
  const messages = useBranchesMessages()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const highlighted = searchParams.get("branch")

  const branchesQuery = useQuery({
    ...listBranchesOptions(),
    retry: false,
    refetchInterval: (query) => branchesPollInterval(query.state.data?.branches),
  })
  const listed = branchesQuery.data?.branches
  const branches = useMemo(() => listed && sortBranches(listed), [listed])
  const unavailable = branchesQuery.data?.unavailable ?? null

  // The banner of a branch's app links here to refresh it: ask once the branch is listed.
  const wantsRefresh = searchParams.get("refresh") === "1"
  useEffect(() => {
    if (!wantsRefresh || !highlighted || !branches) return
    if (branches.some((branch) => branch.name === highlighted)) {
      setConfirm({ kind: "refresh", name: highlighted })
    }
    setSearchParams(
      (params) => {
        params.delete("refresh")
        return params
      },
      { replace: true }
    )
  }, [wantsRefresh, highlighted, branches, setSearchParams])

  const settled = () => queryClient.invalidateQueries({ queryKey: listBranchesQueryKey() })
  const failed = (error: unknown) => notify.error(apiErrorMessage(error, messages.actionFailed))

  const openMutation = useMutation({
    ...openBranchMutation(),
    onSuccess: (branch) => notify.success(messages.started(branch.name)),
    onError: failed,
    onSettled: settled,
  })
  const refreshMutation = useMutation({
    ...refreshBranchMutation(),
    onSuccess: (branch) => notify.success(messages.refreshed(branch.name)),
    onError: failed,
    onSettled: settled,
  })
  const stopMutation = useMutation({
    ...stopBranchMutation(),
    onSuccess: (branch) => notify.success(messages.stopped(branch.name)),
    onError: failed,
    onSettled: settled,
  })
  const deleteMutation = useMutation({
    ...deleteBranchMutation(),
    onSuccess: (branch) => notify.success(messages.deleted(branch.name)),
    onError: failed,
    onSettled: settled,
  })
  const signIn = useMutation({ ...signIntoBranchMutation() })

  // The tab opens on the click, or the browser blocks it; it goes to the branch once production
  // has signed the person in. The branch's page never gets a handle on this one.
  const openInTab = (name: string) => {
    const tab = window.open("", "_blank")
    if (!tab) {
      notify.error(messages.popupBlocked)
      return
    }
    showSigningIn(tab, messages.opening)
    setOpening(name)
    signIn.mutate(
      { body: { name } },
      {
        onSuccess: ({ url }) => {
          tab.opener = null
          tab.location.replace(url)
        },
        onError: (error) => {
          tab.close()
          notify.error(apiErrorMessage(error, messages.openFailed))
        },
        onSettled: () => setOpening(null),
      }
    )
  }

  const canOpenNew = branchesQuery.isSuccess && unavailable === null
  const newButton = canOpenNew ? (
    <Button type="button" size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {messages.newBranch}
    </Button>
  ) : null

  return (
    <SectionPage
      section="console"
      page="branches"
      title={messages.title}
      description={messages.description}
      actions={branches && branches.length > 0 ? newButton : undefined}
    >
      <Panel>
        {branchesQuery.isPending ? (
          <PanelSkeleton rows={2} trailing={<SkeletonBlock className="h-8 w-16 rounded-md" />} />
        ) : branchesQuery.isError ? (
          <LoadFailed error={branchesQuery.error} onRetry={() => branchesQuery.refetch()} />
        ) : unavailable ? (
          <SetupNeeded unavailable={unavailable} />
        ) : !branches || branches.length === 0 ? (
          <PanelEmpty
            icon={GitFork}
            title={messages.empty.title}
            description={messages.empty.description}
            action={newButton}
          />
        ) : (
          branches.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              highlighted={branch.name === highlighted}
              opening={opening === branch.name}
              onOpen={() => openInTab(branch.name)}
              onStart={() => openMutation.mutate({ body: { name: branch.name } })}
              onStop={() => stopMutation.mutate({ body: { name: branch.name } })}
              onRefresh={() => setConfirm({ kind: "refresh", name: branch.name })}
              onDelete={() => setConfirm({ kind: "delete", name: branch.name })}
            />
          ))
        )}
      </Panel>

      <ConfirmDialog
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onConfirm={(target) => {
          const body = { name: target.name }
          if (target.kind === "refresh") refreshMutation.mutate({ body })
          else deleteMutation.mutate({ query: body })
          setConfirm(null)
        }}
      />
      <NewBranchDialog
        open={creating}
        onOpenChange={setCreating}
        pending={openMutation.isPending}
        onSubmit={(name) =>
          openMutation.mutate({ body: { name } }, { onSuccess: () => setCreating(false) })
        }
      />
    </SectionPage>
  )
}

/** The list could not be read: why, in a sentence, and a way to try again. */
function LoadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const messages = useBranchesMessages()
  const failure = useLoadFailure(error, { denied: messages.denied })
  return (
    <PanelEmpty
      tone="error"
      icon={GitFork}
      title={messages.loadFailed}
      description={failure.description}
      action={
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          {messages.tryAgain}
        </Button>
      }
    />
  )
}

/** A blank tab while production signs the person in: a line of text, never a white flash. */
function showSigningIn(tab: Window, text: string) {
  try {
    tab.document.title = text
    const body = tab.document.body
    body.style.cssText =
      "margin:0;height:100vh;display:grid;place-items:center;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#71717a;background:#fafafa"
    if (tab.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      body.style.background = "#09090b"
      body.style.color = "#a1a1aa"
    }
    body.textContent = text
  } catch {
    // A browser that keeps the blank tab to itself shows it blank.
  }
}

/** What production lacks to run branches: one sentence, and the one thing to do. */
function SetupNeeded({ unavailable }: { readonly unavailable: Unavailable }) {
  const messages = useBranchesMessages()
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <IconTile icon={GitFork} size="lg" />
      <p className="mt-4 text-sm font-medium">{messages.setup.title}</p>
      <p className="mt-1 max-w-[46ch] text-[0.8125rem] leading-5 text-muted-foreground">
        {messages.setup[unavailable.code]}
      </p>
      {unavailable.code === "source" ? (
        <pre className="mt-4 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-left font-mono text-xs leading-5">
          {'source: { repository: "acme/shop" }'}
        </pre>
      ) : null}
    </div>
  )
}

function BranchRow({
  branch,
  highlighted,
  opening,
  onOpen,
  onStart,
  onStop,
  onRefresh,
  onDelete,
}: {
  readonly branch: Branch
  readonly highlighted: boolean
  readonly opening: boolean
  readonly onOpen: () => void
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onRefresh: () => void
  readonly onDelete: () => void
}) {
  const messages = useBranchesMessages()
  const status = branchStatus(branch)
  const step = branchStep(branch)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" })
  }, [highlighted])

  const busy = status === "deleting"
  const running = branch.wanted === "running" && status !== "attention"
  // Each status has one thing to do, which the row's button does.
  const primary =
    status === "ready" ? (
      <Button type="button" size="sm" onClick={onOpen} disabled={opening}>
        {opening ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
        {messages.actions.open}
      </Button>
    ) : status === "stopped" ? (
      <Button type="button" size="sm" variant="outline" onClick={onStart}>
        <Play />
        {messages.actions.start}
      </Button>
    ) : status === "attention" && branch.wanted !== "running" ? (
      <Button type="button" size="sm" variant="outline" onClick={onStart}>
        <RefreshCw />
        {messages.actions.retry}
      </Button>
    ) : null

  return (
    <div
      ref={ref}
      data-branch={branch.name}
      className={cn(
        "flex flex-col gap-3 px-4 py-3.5 transition-colors",
        highlighted && "bg-muted/50"
      )}
    >
      {/* A phone puts the button under the facts, so the name keeps the row's width. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 sm:flex sm:items-center sm:gap-3.5">
        <span className="hidden sm:block">
          <IconTile icon={GitFork} />
        </span>
        <div className={cn("min-w-0 flex-1", busy && "opacity-60")}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <span className="min-w-0 font-mono text-[0.8125rem] break-all sm:truncate">
              {branch.name}
            </span>
            <Pill tone={statusTones[status]}>{messages.status[status]}</Pill>
          </div>
          <BranchMeta branch={branch} />
        </div>
        {primary ? (
          <div className="col-start-1 row-start-2 mt-2.5 sm:mt-0 sm:shrink-0">{primary}</div>
        ) : null}
        <div className="col-start-2 row-start-1 -mt-1 -mr-1 sm:m-0 sm:shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={messages.actions.more(branch.name)}
                disabled={busy}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onRefresh}>
                <RefreshCw />
                {messages.actions.refresh}
              </DropdownMenuItem>
              {running ? (
                <DropdownMenuItem onSelect={onStop}>
                  <Square />
                  {messages.actions.stop}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {messages.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {step || status === "attention" || branch.notices.length > 0 || hasSkips(branch) ? (
        <div className="flex flex-col gap-2 sm:pl-[3.125rem]">
          {step ? <Progress branch={branch} step={step} /> : null}
          {status === "attention" ? <NeedsAttention branch={branch} /> : null}
          {branch.notices.map((notice) => (
            <Callout key={notice.code} icon={Info}>
              {messages.notices[notice.code]}
            </Callout>
          ))}
          {hasSkips(branch) ? <NotCopied branch={branch} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Data age, who opened it, and when it was last used: the facts that tell branches apart. */
function BranchMeta({ branch }: { readonly branch: Branch }) {
  const messages = useBranchesMessages()
  const format = useFormat()
  const age = (timestamp: string) =>
    Date.now() - Date.parse(timestamp) < 60_000 ? null : format.relative(timestamp)
  const dataAge = branch.data ? age(branch.data.takenAt) : undefined

  return (
    // One fact a line on a phone, where a wrapped line would strand its separator.
    <div className="mt-0.5 flex min-w-0 flex-col text-[0.8125rem] text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5">
      <span>
        {dataAge === undefined
          ? messages.noData
          : dataAge === null
            ? messages.dataJustNow
            : messages.dataFrom(dataAge)}
      </span>
      <span className="hidden sm:inline">
        <MetaDot />
      </span>
      <OpenedBy userId={branch.createdBy} />
      {branch.state === "ready" && branch.wanted === "running" ? (
        <span className="hidden sm:inline-flex sm:items-center sm:gap-x-1.5">
          <MetaDot />
          {messages.lastUsed(format.relative(branch.lastSeenAt))}
        </span>
      ) : null}
    </div>
  )
}

function OpenedBy({ userId }: { readonly userId: string }) {
  const messages = useBranchesMessages()
  const me = useCurrentUser()
  const person = useUser(userId, { enabled: me?.id !== userId, retry: false }).data
  if (me?.id === userId) return <span>{messages.openedByYou}</span>
  return <span>{messages.openedBy(person?.displayName || person?.email || userId)}</span>
}

/** The steps a branch takes on its way up, the current one live, the rest done or waiting. */
function Progress({ branch, step }: { readonly branch: Branch; readonly step: BranchStep }) {
  const messages = useBranchesMessages()
  const current = STEPS.indexOf(step)
  const waitingForWorker =
    step === "preparing" &&
    branch.state === "stopped" &&
    Date.now() - Date.parse(branch.openedAt) > WORKER_WAIT_MS

  return (
    <div className="flex flex-col gap-1.5">
      <ol
        aria-label={messages.steps.label}
        className="flex flex-col gap-1 text-[0.8125rem] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2"
      >
        {STEPS.map((name, index) => {
          const state = index < current ? "done" : index === current ? "current" : "waiting"
          return (
            <li key={name} className="flex items-center gap-2">
              {index > 0 ? (
                <ChevronRight
                  aria-hidden
                  className="hidden size-3.5 text-muted-foreground/50 sm:block"
                />
              ) : null}
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  state === "current" && "font-medium text-foreground",
                  state !== "current" && "text-muted-foreground"
                )}
                aria-current={state === "current" ? "step" : undefined}
              >
                {state === "done" ? (
                  <Check aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : state === "current" ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin text-sky-600" />
                ) : (
                  <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
                )}
                {messages.steps[name]}
                <span className="sr-only">({messages.steps[state]})</span>
              </span>
            </li>
          )
        })}
      </ol>
      {waitingForWorker ? (
        <p className="text-xs text-muted-foreground">{messages.waitingForWorker}</p>
      ) : null}
    </div>
  )
}

/** Why a branch isn't running: a sentence first, the error itself folded under Details. */
function NeedsAttention({ branch }: { readonly branch: Branch }) {
  const messages = useBranchesMessages().attention
  const error = branch.error
  // A runtime that fails to start keeps its branch wanted: the next push reloads it.
  const code = branch.wanted === "running"
  const file = error?.file

  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 px-3.5 py-2.5 dark:border-red-900/60 dark:bg-red-950/30">
      <div className="flex items-start gap-2.5">
        <CircleAlert
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[0.8125rem] font-medium text-foreground">
            {code ? messages.code : messages.machine}
          </p>
          {code ? (
            <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
              {file ? (
                <>
                  {messages.codeHint(file).split(file)[0]}
                  <code className="font-mono text-xs text-foreground">{file}</code>
                  {messages.codeHint(file).split(file)[1]}
                </>
              ) : (
                messages.codeHintNoFile
              )}
            </p>
          ) : null}
          {error ? (
            <Collapsible>
              <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                />
                {messages.details}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
                  {error.message}
                </pre>
                <div className="mt-1.5">
                  <CopyButton value={file ? `${file}\n\n${error.message}` : error.message} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** A calm line about the branch, such as its data having been reset. */
function Callout({
  icon: Icon,
  children,
}: {
  readonly icon: typeof Info
  readonly children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-muted/60 px-3.5 py-2.5 text-[0.8125rem] text-muted-foreground">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0">{children}</p>
    </div>
  )
}

function hasSkips(branch: Branch): boolean {
  return (branch.data?.skipped.length ?? 0) + (branch.data?.skippedDatasets.length ?? 0) > 0
}

/** What the copy left out, folded: each type and dataset with a plain reason. */
function NotCopied({ branch }: { readonly branch: Branch }) {
  const messages = useBranchesMessages().notCopied
  const me = useCurrentUser()
  const creator = useUser(branch.createdBy, {
    enabled: me?.id !== branch.createdBy,
    retry: false,
  }).data
  const who =
    me?.id === branch.createdBy
      ? (me.displayName ?? me.email)
      : creator?.displayName || creator?.email || messages.someone
  const types = branch.data?.skipped ?? []
  const datasets = branch.data?.skippedDatasets ?? []

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 rounded text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
        />
        {messages.summary(types.length, datasets.length)}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
          {types.map((skip) => (
            <SkipRow
              key={`type:${skip.objectTypeId}`}
              name={skip.objectTypeId}
              reason={
                skip.reason.startsWith("the person who took it")
                  ? messages.unreadable(who)
                  : messages.changed
              }
              detail={skip.reason.startsWith("the person who took it") ? undefined : skip.reason}
            />
          ))}
          {datasets.map((skip) => (
            <SkipRow
              key={`dataset:${skip.datasetId}`}
              name={skip.datasetId}
              reason={messages.hiddenColumns(who, skip.columns.join(", "))}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SkipRow({
  name,
  reason,
  detail,
}: {
  readonly name: string
  readonly reason: string
  readonly detail?: string
}) {
  return (
    <li className="px-3.5 py-2.5 text-[0.8125rem]">
      <span className="font-mono text-xs font-medium">{name}</span>
      <p className="mt-0.5 text-muted-foreground">{reason}</p>
      {detail ? (
        <p className="mt-0.5 font-mono text-xs text-muted-foreground/80">{detail}</p>
      ) : null}
    </li>
  )
}

/** Refresh and Delete ask once, saying what is lost. */
function ConfirmDialog({
  confirm,
  onClose,
  onConfirm,
}: {
  readonly confirm: Confirm | null
  readonly onClose: () => void
  readonly onConfirm: (confirm: Confirm) => void
}) {
  const messages = useBranchesMessages()
  // Kept while the dialog closes, so its text doesn't change under the animation.
  const [shown, setShown] = useState(confirm)
  useEffect(() => {
    if (confirm) setShown(confirm)
  }, [confirm])
  const text = shown?.kind === "delete" ? messages.remove : messages.refresh

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {text.title(shown?.name ?? "")}
          </AlertDialogTitle>
          <AlertDialogDescription>{text.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={shown?.kind === "delete" ? "destructive" : "default"}
            onClick={() => (shown ? onConfirm(shown) : undefined)}
          >
            {text.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// What git accepts closely enough to catch a typo before production does.
const GIT_BRANCH = /^(?!\/|.*\/$|.*\.\.|.*\/\/)[^\s~^:?*[\\]+$/

function NewBranchDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly pending: boolean
  readonly onSubmit: (name: string) => void
}) {
  const messages = useBranchesMessages()
  const [name, setName] = useState("")
  const [invalid, setInvalid] = useState(false)
  const inputId = useId()
  const errorId = useId()

  useEffect(() => {
    if (!open) {
      setName("")
      setInvalid(false)
    }
  }, [open])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!GIT_BRANCH.test(trimmed)) {
      setInvalid(true)
      return
    }
    onSubmit(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{messages.create.title}</DialogTitle>
            <DialogDescription>{messages.create.description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{messages.create.label}</Label>
            <Input
              id={inputId}
              value={name}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={messages.create.placeholder}
              className="font-mono text-sm"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value)
                setInvalid(false)
              }}
            />
            {invalid ? (
              <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
                {messages.create.invalid}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {messages.cancel}
            </Button>
            <Button type="submit" disabled={pending || name.trim() === ""}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {messages.create.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
