import type { GetDatasetResponse } from "@sixb/client"
import { Badge, Button } from "@sixb/ui/components"
import { GitBranch } from "lucide-react"
import { consumerCount, formatBytes, formatCount, sourceCount } from "../../lib/datasets"
import { formatRelativeTime } from "../../lib/time"

type DatasetVersionSummary = {
  versionId?: string
  rowCount?: number
  sizeBytes?: number
  createdAt?: string
  mode?: string
  producer?: { kind: string; id?: string; runId?: string }
}

type DatasetDetailsProps = {
  dataset: GetDatasetResponse
  columnCount: number
  versionSummary: DatasetVersionSummary
  onNavigate: (path: string) => void
}

export function DatasetDetails({
  dataset,
  columnCount,
  versionSummary,
  onNavigate,
}: DatasetDetailsProps) {
  const hasReferences = sourceCount(dataset) + consumerCount(dataset) > 0
  const primaryKey =
    typeof dataset.primaryKey === "string" ? [dataset.primaryKey] : (dataset.primaryKey ?? [])
  const producer = versionSummary.producer
    ? `${versionSummary.producer.kind}${
        versionSummary.producer.id ? ` · ${versionSummary.producer.id}` : ""
      }`
    : null

  return (
    <div className="max-h-[70vh] space-y-4 overflow-auto scrollbar-auto-hide">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <StatItem label="Rows" value={formatCount(versionSummary.rowCount)} />
        <StatItem label="Columns" value={columnCount} />
        <StatItem label="Size" value={formatBytes(versionSummary.sizeBytes)} />
        <StatItem
          label="Created"
          value={versionSummary.createdAt ? formatRelativeTime(versionSummary.createdAt) : "—"}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="font-normal">
          {dataset.materialized ? "Materialized" : "Declared"}
        </Badge>
        {versionSummary.mode ? (
          <Badge variant="outline" className="font-normal">
            {versionSummary.mode}
          </Badge>
        ) : null}
      </div>

      {versionSummary.versionId ? (
        <Field label="Version">
          <p className="break-all font-mono text-xs text-foreground">{versionSummary.versionId}</p>
        </Field>
      ) : null}

      <Field label="Description">
        <p className="text-sm text-foreground">{dataset.description ?? "No description"}</p>
      </Field>

      {producer ? (
        <Field label="Producer">
          <p className="break-all font-mono text-xs text-foreground">{producer}</p>
        </Field>
      ) : null}

      {dataset.partitionBy?.length ? (
        <Field label="Partitioned by">
          <div className="flex flex-wrap gap-1.5">
            {dataset.partitionBy.map((column) => (
              <Badge key={column} variant="outline" className="font-mono text-[11px] font-normal">
                {column}
              </Badge>
            ))}
          </div>
        </Field>
      ) : null}

      {primaryKey.length > 0 ? (
        <Field label="Primary key">
          <div className="flex flex-wrap gap-1.5">
            {primaryKey.map((column) => (
              <Badge key={column} variant="outline" className="font-mono text-[11px] font-normal">
                {column}
              </Badge>
            ))}
          </div>
        </Field>
      ) : null}

      {hasReferences ? (
        <div className="space-y-4 border-t border-border/50 pt-4">
          <ReferenceGroup
            label="Syncs"
            ids={dataset.syncIds}
            onSelect={(id) => onNavigate(`/syncs/${encodeURIComponent(id)}`)}
          />
          <ReferenceGroup label="Source pipelines" ids={dataset.sourcePipelineIds} />
          <ReferenceGroup label="Target pipelines" ids={dataset.targetPipelineIds} />
          <ReferenceGroup label="Projections" ids={dataset.projectionIds} />
        </div>
      ) : null}
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-medium tabular-nums text-foreground">{value}</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  )
}

function ReferenceGroup({
  label,
  ids,
  onSelect,
}: {
  label: string
  ids: string[]
  onSelect?: (id: string) => void
}) {
  if (ids.length === 0) return null

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">
        {ids.map((id) => {
          const content = (
            <>
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{id}</span>
            </>
          )
          return onSelect ? (
            <Button
              key={id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSelect(id)}
              className="-mx-2 h-7 max-w-full justify-start gap-2 font-mono text-xs text-foreground"
            >
              {content}
            </Button>
          ) : (
            <span
              key={id}
              className="flex max-w-full items-center gap-2 py-1 font-mono text-xs text-foreground"
            >
              {content}
            </span>
          )
        })}
      </div>
    </div>
  )
}
