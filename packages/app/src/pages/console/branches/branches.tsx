import { isSixbApiError, type ListBranchesResponse } from "@sixb/client"
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
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Clock,
  GitFork,
  Info,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
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

export type Branch = ListBranchesResponse["branches"][number] & {
  /**
   * Why production can't get the branch from its repository, as its last read of the remote
   * said: a branch that waits for it says so. Optional: a server may not send it.
   */
  readonly remoteError?: string | null
}
type Unavailable = NonNullable<ListBranchesResponse["unavailable"]>

/** What a branch is doing, in the words a person reads on its pill. */
export type BranchStatus = keyof BranchesMessages["status"]

/** Where a branch that is on its way up is: the step it is on. */
export type BranchStep = "preparing" | "copying" | "starting"

const STEPS: readonly BranchStep[] = ["preparing", "copying", "starting"]

/** How long a branch waits for a worker before the page says it is waiting for a free one. */
export const WORKER_WAIT_MS = 60_000

/** How often the list is read while a branch moves, and while none does. */
export const BRANCHES_POLL_MS = { moving: 2_000, settled: 15_000 } as const

/** What setting each setup state asks for, as a line of sixb.config.ts. */
const SETUP_SNIPPETS: Partial<Record<Unavailable["code"], string>> = {
  storage: "storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }),",
  source: 'source: { repository: "your-org/your-repo" },',
  sandboxes: "sandboxes: new VercelSandboxFactory({ credentials }),",
  "sandbox-shares-host": "sandboxes: new VercelSandboxFactory({ credentials }),",
}

const SETUP_GUIDE = "https://docs.sixb.ai/deployment/branches"

/** The command that runs branches next to production. */
const WORKER_COMMAND = "sixb worker branches"

/**
 * The pill a branch shows: what a person can do with it now. `now` is production's time, which
 * the branch's own times were written in: a reader's clock ahead of it would make a branch wait.
 */
export function branchStatus(branch: Branch, now = Date.now()): BranchStatus {
  if (branch.wanted === "deleted") return "deleting"
  if (branch.state === "failed") return "attention"
  if (branch.wanted === "stopped") return branch.state === "stopped" ? "stopped" : "stopping"
  if (unclaimed(branch, now)) return "waiting"
  if (refreshPending(branch)) return "refreshing"
  if (branch.state === "ready") return "ready"
  return "starting"
}

/**
 * Nothing has taken the branch up a minute after it was last asked for, opened or refreshed. Its
 * workers may be busy with other branches, restarting or not running: the page can't tell which.
 * One production can't get from the repository waits at once, and says why.
 */
function unclaimed(branch: Branch, now: number): boolean {
  if (branch.state !== "stopped") return false
  if (branch.remoteError) return true

  const opened = Date.parse(branch.openedAt)
  const refreshed = branch.refreshRequestedAt ? Date.parse(branch.refreshRequestedAt) : opened
  return now - Math.max(opened, refreshed) > WORKER_WAIT_MS
}

/** The step a branch on its way up is on, or null when it isn't on its way. */
export function branchStep(branch: Branch, now = Date.now()): BranchStep | null {
  const status = branchStatus(branch, now)
  if (status !== "starting" && status !== "refreshing" && status !== "waiting") return null
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

/** Statuses on the way to Ready: one that reaches it says so. */
const ON_THE_WAY: ReadonlySet<BranchStatus> = new Set(["starting", "refreshing", "waiting"])

const statusTones: Record<BranchStatus, Tone> = {
  ready: "ok",
  starting: "info",
  waiting: "muted",
  refreshing: "info",
  stopping: "muted",
  stopped: "muted",
  attention: "error",
  deleting: "muted",
}

type Confirm = {
  readonly kind: "refresh" | "delete"
  readonly name: string
  /** Whose view of production a refresh copies: the branch's creator, whoever asks. */
  readonly createdBy: string
}

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
  const [announcement, setAnnouncement] = useState("")
  const highlighted = searchParams.get("branch")

  const branchesQuery = useQuery({
    ...listBranchesOptions(),
    retry: false,
    refetchInterval: (query) => branchesPollInterval(query.state.data?.branches),
  })
  const listed = branchesQuery.data?.branches
  const branches = useMemo(() => listed && sortBranches(listed), [listed])
  const unavailable = branchesQuery.data?.unavailable ?? null
  // Production's clock, as of its last answer: the one the branches' times were written in.
  const now = branchesQuery.data ? Date.parse(branchesQuery.data.now) : Date.now()

  // The banner of a branch's app links here to refresh it: ask once the branch is listed.
  const wantsRefresh = searchParams.get("refresh") === "1"
  useEffect(() => {
    if (!wantsRefresh || !highlighted || !branches) return
    const target = branches.find((branch) => branch.name === highlighted)
    if (target) setConfirm({ kind: "refresh", name: target.name, createdBy: target.createdBy })
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

  // What changes while the page is open is said aloud, and a branch that becomes ready offers to
  // open it. The first read only sets what was there. Read through a ref: the effect follows the
  // list alone.
  const latest = useRef({ messages, openInTab, now })
  latest.current = { messages, openInTab, now }
  const seen = useRef<Map<string, BranchStatus> | null>(null)
  useEffect(() => {
    if (!branches) return
    const statuses = new Map(
      branches.map((branch) => [branch.name, branchStatus(branch, latest.current.now)])
    )
    const before = seen.current
    seen.current = statuses
    if (!before) return

    const { messages: text, openInTab: open } = latest.current
    for (const [name, status] of statuses) {
      const was = before.get(name)
      if (was === undefined || was === status) continue
      setAnnouncement(text.announce(name, text.status[status]))
      if (status === "ready" && ON_THE_WAY.has(was)) {
        notify.success(text.ready(name), { label: text.actions.open, onClick: () => open(name) })
      }
    }
  }, [branches])

  const canStartNew = branchesQuery.isSuccess && unavailable === null
  const newButton = canStartNew ? (
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
      actions={
        branchesQuery.isPending ? (
          // Where New branch appears, so the header doesn't move when it does.
          <SkeletonBlock className="h-8 w-[7.25rem] rounded-md" />
        ) : branches && branches.length > 0 ? (
          newButton
        ) : undefined
      }
    >
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
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
              now={now}
              highlighted={branch.name === highlighted}
              opening={opening === branch.name}
              onOpen={() => openInTab(branch.name)}
              onStart={() => openMutation.mutate({ body: { name: branch.name } })}
              onStop={() => stopMutation.mutate({ body: { name: branch.name } })}
              onRefresh={() =>
                setConfirm({ kind: "refresh", name: branch.name, createdBy: branch.createdBy })
              }
              onDelete={() =>
                setConfirm({ kind: "delete", name: branch.name, createdBy: branch.createdBy })
              }
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

/** The list could not be read: what happened, and a way to try again unless access is missing. */
function LoadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const messages = useBranchesMessages()
  const denied = isSixbApiError(error) && error.status === 403
  const failure = useLoadFailure(error, {
    denied: messages.denied,
    fallback: messages.checkConnection,
  })
  return (
    <PanelEmpty
      tone="error"
      icon={GitFork}
      title={denied ? failure.title : messages.loadFailed}
      description={failure.description}
      action={
        denied ? undefined : (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw />
            {messages.tryAgain}
          </Button>
        )
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

/** A line of configuration or a command, with a way to copy it. */
function Snippet({ value }: { readonly value: string }) {
  return (
    <div className="flex max-w-full items-center gap-1 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3.5">
      <code className="min-w-0 overflow-x-auto py-1.5 font-mono text-xs leading-5 whitespace-pre">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  )
}

/** What production lacks to run branches: one sentence, the setting, and the guide. */
function SetupNeeded({ unavailable }: { readonly unavailable: Unavailable }) {
  const messages = useBranchesMessages()
  const snippet = SETUP_SNIPPETS[unavailable.code]
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <IconTile icon={GitFork} size="lg" />
      <p className="mt-4 text-sm font-medium">{messages.setup.title}</p>
      <p className="mt-1 max-w-[46ch] text-[0.8125rem] leading-5 text-muted-foreground">
        {messages.setup[unavailable.code]}
      </p>
      {snippet ? (
        <div className="mt-4 max-w-full text-left">
          <Snippet value={snippet} />
        </div>
      ) : null}
      <Button asChild variant="link" size="sm" className="mt-3 text-muted-foreground">
        <a href={SETUP_GUIDE} target="_blank" rel="noopener noreferrer">
          <BookOpen />
          {messages.setup.guide}
        </a>
      </Button>
    </div>
  )
}

function BranchRow({
  branch,
  now,
  highlighted,
  opening,
  onOpen,
  onStart,
  onStop,
  onRefresh,
  onDelete,
}: {
  readonly branch: Branch
  /** Production's time, which the branch's own times are in. */
  readonly now: number
  readonly highlighted: boolean
  readonly opening: boolean
  readonly onOpen: () => void
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onRefresh: () => void
  readonly onDelete: () => void
}) {
  const messages = useBranchesMessages()
  const status = branchStatus(branch, now)
  const step = branchStep(branch, now)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" })
  }, [highlighted])

  const deleting = status === "deleting"
  const onTheWay = ON_THE_WAY.has(status)
  const running = branch.wanted === "running" && status !== "attention"
  const pill = <Pill tone={statusTones[status]}>{messages.status[status]}</Pill>
  // Each status has one thing to do, which the row's button does: Open a ready branch, Start a
  // stopped one, Try again one whose machine failed.
  const primary =
    status === "ready" ? (
      <Button type="button" size="sm" onClick={onOpen} disabled={opening}>
        {opening ? <Loader2 className="motion-safe:animate-spin" /> : <ArrowUpRight />}
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
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-x-2 text-sm font-medium">
            <span
              title={branch.name}
              className={cn(
                "min-w-0 font-mono text-[0.8125rem] break-all sm:truncate",
                deleting && "text-muted-foreground"
              )}
            >
              {branch.name}
            </span>
            <span className="hidden sm:inline-flex">{pill}</span>
          </div>
          <BranchMeta branch={branch} pill={<span className="sm:hidden">{pill}</span>} />
        </div>
        {primary ? (
          <div className="col-start-1 row-start-2 mt-2.5 sm:mt-0 sm:shrink-0">{primary}</div>
        ) : null}
        <div className="col-start-2 row-start-1 -mt-1.5 -mr-1.5 sm:m-0 sm:shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="max-sm:size-9"
                aria-label={messages.actions.more(branch.name)}
                disabled={deleting}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* A branch on its way up already takes a copy. */}
              {onTheWay ? null : (
                <DropdownMenuItem onSelect={onRefresh}>
                  <RefreshCw />
                  {messages.actions.refresh}
                </DropdownMenuItem>
              )}
              {running ? (
                <DropdownMenuItem onSelect={onStop}>
                  <CircleStop />
                  {messages.actions.stop}
                </DropdownMenuItem>
              ) : null}
              {onTheWay && !running ? null : <DropdownMenuSeparator />}
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
          {step ? <Progress step={step} waiting={status === "waiting"} /> : null}
          {status === "waiting" ? <Waiting branch={branch} /> : null}
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

/**
 * Data age, who started it, and when it was last opened: the facts that tell branches apart. One
 * line on a wide screen, cut short rather than wrapped, so no separator is left alone at a line's
 * start; one fact a line on a phone, after the status.
 */
function BranchMeta({ branch, pill }: { readonly branch: Branch; readonly pill: ReactNode }) {
  const messages = useBranchesMessages()
  const format = useFormat()
  const startedBy = useStartedBy(branch.createdBy)
  const data = !branch.data
    ? branch.state === "copying"
      ? messages.copyingData
      : messages.noData
    : Date.now() - Date.parse(branch.data.takenAt) < 60_000
      ? messages.dataJustNow
      : messages.dataFrom(format.relative(branch.data.takenAt))
  const lastOpened =
    branch.state === "ready" && branch.wanted === "running"
      ? messages.lastOpened(format.relative(branch.lastSeenAt))
      : null

  return (
    // On a wide screen the facts keep to one line: one that doesn't fit wraps onto a second line
    // the row never shows, whole, rather than cut mid-word. The tooltip still says them all.
    <div
      title={[data, startedBy, lastOpened].filter(Boolean).join(" · ")}
      className="mt-0.5 flex min-w-0 flex-col items-start gap-y-0.5 text-[0.8125rem] text-muted-foreground sm:h-5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:overflow-hidden sm:whitespace-nowrap"
    >
      {pill}
      <span className="shrink-0">{data}</span>
      <span className="hidden shrink-0 items-center gap-x-1.5 sm:flex">
        <MetaDot />
        {startedBy}
      </span>
      <span className="shrink-0 sm:hidden">{startedBy}</span>
      {lastOpened ? (
        <span className="hidden shrink-0 items-center gap-x-1.5 sm:flex">
          <MetaDot />
          {lastOpened}
        </span>
      ) : null}
    </div>
  )
}

/** "Started by you", or by whoever started the branch, by name when the directory says. */
function useStartedBy(userId: string): string {
  const messages = useBranchesMessages()
  const me = useCurrentUser()
  const person = useUser(userId, { enabled: me?.id !== userId, retry: false }).data
  if (me?.id === userId) return messages.startedByYou
  return messages.startedBy(person?.displayName || person?.email || userId)
}

/**
 * Who started the branch, as a refresh names them: null for the reader, their name when the
 * directory says, else the person who started it.
 */
function useCreatorName(userId: string | null): string | null {
  const messages = useBranchesMessages()
  const me = useCurrentUser()
  const mine = userId === null || me?.id === userId
  const person = useUser(userId ?? "", { enabled: !mine, retry: false }).data
  if (mine) return null
  return person?.displayName || person?.email || messages.refresh.someone
}

/** The steps a branch takes on its way up, the current one live, the rest done or waiting. */
function Progress({ step, waiting }: { readonly step: BranchStep; readonly waiting: boolean }) {
  const messages = useBranchesMessages()
  const current = STEPS.indexOf(step)

  return (
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
              {/* Every marker in one box, so the labels line up whatever the marker. */}
              <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
                {state === "done" ? (
                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : state === "current" && waiting ? (
                  <Clock className="size-3.5 text-muted-foreground" />
                ) : state === "current" ? (
                  <Loader2 className="size-3.5 text-sky-600 motion-safe:animate-spin dark:text-sky-400" />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                )}
              </span>
              {messages.steps[name]}
              <span className="sr-only">({messages.steps[state]})</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Why the branch waits: production can't get it from the repository, with its error folded under
 * Details; or no worker took it up yet, and what to check if that lasts.
 */
function Waiting({ branch }: { readonly branch: Branch }) {
  const messages = useBranchesMessages()

  if (branch.remoteError) {
    return (
      <Callout icon={Clock}>
        <span className="block font-medium text-foreground">{messages.remote.title}</span>
        <span className="mt-0.5 block">{messages.remote.hint}</span>
        <ErrorDetails message={branch.remoteError} />
      </Callout>
    )
  }

  return (
    <Callout icon={Clock}>
      <span className="block">{messages.waitingForWorker}</span>
      <span className="mt-2 inline-flex max-w-full">
        <Snippet value={WORKER_COMMAND} />
      </span>
    </Callout>
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
    <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5">
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
              {file ? withCode(messages.codeHint(file), file) : messages.codeHintNoFile}
            </p>
          ) : null}
          {error ? (
            <ErrorDetails
              message={error.message}
              copy={file ? `${file}\n\n${error.message}` : error.message}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** An error as it was written, folded under Details, with a way to copy it. */
function ErrorDetails({
  message,
  copy = message,
}: {
  readonly message: string
  readonly copy?: string
}) {
  const messages = useBranchesMessages().attention

  return (
    <Collapsible>
      <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
        />
        {messages.details}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-red-700 dark:text-red-300">
          {message}
        </pre>
        <div className="mt-1.5">
          <CopyButton value={copy} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** `text` with `code`, a name it holds, set as code. */
function withCode(text: string, code: string): ReactNode {
  const at = text.indexOf(code)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <code className="font-mono text-[0.92em] text-foreground">{code}</code>
      {text.slice(at + code.length)}
    </>
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
      <div className="min-w-0">{children}</div>
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
      {detail ? <p className="mt-0.5 font-mono text-xs text-muted-foreground">{detail}</p> : null}
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
  const creator = useCreatorName(shown?.createdBy ?? null)
  const name = shown?.name ?? ""
  const text = shown?.kind === "delete" ? messages.remove : messages.refresh
  // A refresh copies what the branch's creator sees, whoever asks for it.
  const description =
    shown?.kind === "delete"
      ? messages.remove.description
      : creator === null
        ? messages.refresh.description
        : messages.refresh.descriptionOf(creator)

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {withCode(text.title(name), name)}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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

/** What is wrong with a branch name, in the words a person fixes it with, or null. */
export function branchNameProblem(name: string): "spaces" | "invalid" | null {
  if (/\s/.test(name)) return "spaces"
  return GIT_BRANCH.test(name) ? null : "invalid"
}

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
  const [problem, setProblem] = useState<"spaces" | "invalid" | null>(null)
  const inputId = useId()
  const errorId = useId()

  useEffect(() => {
    if (!open) {
      setName("")
      setProblem(null)
    }
  }, [open])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    const found = branchNameProblem(trimmed)
    if (found) {
      setProblem(found)
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
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value)
                setProblem(null)
              }}
            />
            {problem ? (
              <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
                {messages.create[problem]}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {messages.cancel}
            </Button>
            <Button type="submit" disabled={pending || name.trim() === ""}>
              {pending ? <Loader2 className="motion-safe:animate-spin" /> : null}
              {messages.create.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
