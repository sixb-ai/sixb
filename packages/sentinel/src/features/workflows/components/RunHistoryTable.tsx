import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@pario/ui/components"
import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"
import {
  formatDate,
  formatRunDuration,
  runTimeLabel,
  type WorkflowRunSummary,
} from "../utils/workflows"
import { RunListItem } from "./RunListItem"
import { useRunHistoryNavigation } from "./runHistoryNavigation"
import { StatusBadge } from "./StatusBadge"

type RunHistoryTableVariant = "framed" | "plain"

export function RunHistoryTable({
  runs,
  variant = "framed",
}: {
  runs: readonly WorkflowRunSummary[]
  variant?: RunHistoryTableVariant
}) {
  const framed = variant === "framed"
  return (
    <>
      <div
        className={
          framed
            ? "hidden overflow-hidden rounded-lg border border-border md:block"
            : "hidden md:block"
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Error</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <RunHistoryTableRow key={run.id} run={run} />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className={framed ? "grid gap-3 md:hidden" : "space-y-2 px-4 py-4 md:hidden"}>
        {runs.map((run) =>
          framed ? (
            <RunListItem key={run.id} run={run} expanded />
          ) : (
            <RunHistoryCard key={run.id} run={run} />
          )
        )}
      </div>
    </>
  )
}

function RunHistoryCard({ run }: { run: WorkflowRunSummary }) {
  const { workflowPath, onContainerClick, onContainerKeyDown } = useRunHistoryNavigation(run)

  return (
    <article
      role="link"
      tabIndex={0}
      aria-label={`Open run ${run.id}`}
      onClick={onContainerClick}
      onKeyDown={onContainerKeyDown}
      className="block cursor-pointer rounded-lg border border-border bg-background/60 p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-muted-foreground">{run.id}</p>
          <Link
            to={workflowPath}
            className="mt-1 block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            {run.workflowId}
          </Link>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <RunMetric label="Queued" value={formatDate(run.queuedAt ?? run.startedAt)} />
        <RunMetric label="Time" value={runTimeLabel(run)} />
        <RunMetric label="Duration" value={formatRunDuration(run)} />
        <RunMetric label="Status" value={run.status} />
      </div>
      {run.error ? <p className="mt-3 break-words text-xs text-destructive">{run.error}</p> : null}
    </article>
  )
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-foreground">{value}</p>
    </div>
  )
}

function RunHistoryTableRow({ run }: { run: WorkflowRunSummary }) {
  const { runPath, workflowPath, onContainerClick } = useRunHistoryNavigation(run)

  return (
    <TableRow
      onClick={onContainerClick}
      className="cursor-pointer hover:bg-muted/70"
      aria-label={`Open run ${run.id}`}
    >
      <TableCell className="min-w-[15rem]">
        <Link
          to={runPath}
          className="block truncate font-mono text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          {run.id}
        </Link>
        <Link
          to={workflowPath}
          className="mt-1 block truncate text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {run.workflowId}
        </Link>
      </TableCell>
      <TableCell>
        <StatusBadge status={run.status} />
      </TableCell>
      <TableCell className="min-w-[11rem]">
        <p className="text-sm text-foreground">{runTimeLabel(run)}</p>
        <p className="text-xs text-muted-foreground">{formatDate(run.queuedAt ?? run.startedAt)}</p>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {formatRunDuration(run)}
      </TableCell>
      <TableCell className="max-w-[16rem]">
        {run.error ? (
          <p className="truncate text-xs text-destructive" title={run.error}>
            {run.error}
          </p>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon-sm" asChild aria-label={`Open run ${run.id}`}>
          <Link to={runPath}>
            <ArrowRight />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  )
}
