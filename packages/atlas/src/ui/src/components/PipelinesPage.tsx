import type {
  GetDatasetResponse,
  GetPipelineResponse,
  ListDatasetRowsResponse,
  ListPipelinesResponse,
} from "@pario/client"
import {
  getDatasetOptions,
  getPipelineOptions,
  listDatasetRowsOptions,
  listPipelineRunsOptions,
  listPipelinesOptions,
  requestPipelineRunMutation,
} from "@pario/client/hooks"
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
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge as XYEdge,
} from "@xyflow/react"
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Database,
  FunctionSquare,
  History,
  Loader2,
  LoaderCircle,
  Play,
  Rows3,
  Search,
  Workflow,
  X,
  XCircle,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type PipelineSummary = ListPipelinesResponse[number] | GetPipelineResponse
type PipelineRun = NonNullable<PipelineSummary["latestRun"]>
type PipelineRunStatus = PipelineRun["status"]
type PipelineGraphNode = PipelineSummary["graph"]["nodes"][number]
type PipelineStep = PipelineGraphNode["step"]
type DatasetDefinition = PipelineStep["output"]
type PipelineListViewStyle = "cards" | "table"

const pipelineListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

function pipelineName(pipeline: Pick<PipelineSummary, "id">): string {
  return humanizeIdentifier(pipeline.id)
}

function pipelineSummary(pipeline: PipelineSummary): string {
  const stepCount = pipeline.graph.nodes.length
  const triggerCount = pipeline.triggers.length
  const parts = [`${stepCount} step${stepCount === 1 ? "" : "s"}`]
  if (triggerCount > 0) {
    parts.push(`${triggerCount} trigger${triggerCount === 1 ? "" : "s"}`)
  }
  return parts.join(" · ")
}

function triggerLabel(trigger: PipelineSummary["triggers"][number]): string {
  switch (trigger.type) {
    case "schedule":
      return `Schedule ${trigger.scheduleId}`
    case "sync.finished":
      return `After ${trigger.syncId}`
    case "pipeline.finished":
      return `After ${trigger.pipelineId}`
    case "dataset.updated":
      return `Dataset ${trigger.datasetId}`
  }
}

function runStatusLabel(status: PipelineRunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function runStatusClasses(status: PipelineRunStatus): string {
  switch (status) {
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "cancelled":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300"
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300"
  }
}

function RunStatusBadge({ status }: { status: PipelineRunStatus }) {
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "cancelled"
          ? Ban
          : LoaderCircle

  return (
    <Badge variant="outline" className={cn("rounded-md", runStatusClasses(status))}>
      <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {runStatusLabel(status)}
    </Badge>
  )
}

function runDuration(run: PipelineRun): string {
  if (!run.finishedAt) {
    return run.status === "running" ? "Running" : "Pending"
  }
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "Unknown"
  if (ms < 1000) return "<1s"
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function executorLabel(step: PipelineStep): string {
  switch (step.executor.kind) {
    case "sql":
      return `SQL · ${step.executor.dialect}`
    case "run":
      return "Run"
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const value = (error as { error?: unknown }).error
    if (typeof value === "string") return value
  }
  return "Could not request pipeline run."
}

function PipelineListItem({
  pipeline,
  onSelect,
}: {
  pipeline: ListPipelinesResponse[number]
  onSelect: () => void
}) {
  const latestRun = pipeline.latestRun
  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Workflow className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{pipelineName(pipeline)}</p>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {pipeline.graph.nodes.length} step{pipeline.graph.nodes.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{pipeline.id}</p>
      </div>
      {latestRun ? (
        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
          <RunStatusBadge status={latestRun.status} />
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(latestRun.startedAt)}
          </span>
        </div>
      ) : (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">No runs</span>
      )}
    </CollectionCardButton>
  )
}

function PipelineTableView({
  pipelines,
  onSelect,
}: {
  pipelines: ListPipelinesResponse
  onSelect: (pipelineId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pipeline</TableHead>
            <TableHead className="hidden sm:table-cell">Steps</TableHead>
            <TableHead className="hidden md:table-cell">Triggers</TableHead>
            <TableHead>Latest Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pipelines.map((pipeline) => (
            <TableRow
              key={pipeline.id}
              onClick={() => onSelect(pipeline.id)}
              className="cursor-pointer"
            >
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {pipelineName(pipeline)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{pipeline.id}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                {pipeline.graph.nodes.length}
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                {pipeline.triggers.length}
              </TableCell>
              <TableCell>
                {pipeline.latestRun ? (
                  <div className="flex flex-col items-start gap-1">
                    <RunStatusBadge status={pipeline.latestRun.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(pipeline.latestRun.startedAt)}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No runs</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

export function PipelinesPage() {
  const { data: pipelines = [], isLoading, isError } = useQuery(listPipelinesOptions())
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<PipelineListViewStyle>(() =>
    getCollectionViewStyle("pipelines", ["cards", "table"], "cards")
  )

  const filteredPipelines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return pipelines
    return pipelines.filter((pipeline) => {
      if (pipeline.id.toLowerCase().includes(q)) return true
      if (pipeline.latestRun?.status.toLowerCase().includes(q)) return true
      return pipeline.graph.nodes.some(
        (node) =>
          node.step.id.toLowerCase().includes(q) ||
          node.step.output.id.toLowerCase().includes(q) ||
          node.step.inputs.some((input) => input.dataset.id.toLowerCase().includes(q))
      )
    })
  }, [pipelines, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading pipelines...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<Workflow className="h-10 w-10" />}
            title="Pipelines unavailable"
            description="Could not load pipeline metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectPipeline = (pipelineId: string) => {
    navigate(`/pipelines/${encodeURIComponent(pipelineId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Pipelines"
        count={filteredPipelines.length}
        actions={
          pipelines.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={pipelineListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("pipelines", style)
              }}
            />
          ) : null
        }
      />

      {pipelines.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search pipelines, steps, or datasets..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {pipelines.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-10 w-10" />}
            title="No pipelines"
            description="Registered pipelines will appear here."
          />
        ) : filteredPipelines.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <PipelineTableView pipelines={filteredPipelines} onSelect={handleSelectPipeline} />
        ) : (
          <CollectionCardGrid>
            {filteredPipelines.map((pipeline) => (
              <PipelineListItem
                key={pipeline.id}
                pipeline={pipeline}
                onSelect={() => handleSelectPipeline(pipeline.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Detail page — React Flow canvas
// --------------------------------------------------------------------------

type GraphNodeKind = "dataset" | "step"

interface DatasetNodeData extends Record<string, unknown> {
  kind: "dataset"
  datasetId: string
  columnCount: number
  description?: string
}

interface StepNodeData extends Record<string, unknown> {
  kind: "step"
  stepId: string
  executor: string
  mode: PipelineStep["mode"]
}

type DatasetGraphNode = Node<DatasetNodeData, "dataset">
type StepGraphNode = Node<StepNodeData, "step">
type PipelineGraphFlowNode = DatasetGraphNode | StepGraphNode

const STEP_GAP_X = 280
const ROW_GAP_Y = 140

interface BuiltGraph {
  nodes: PipelineGraphFlowNode[]
  edges: XYEdge[]
  datasets: Map<string, DatasetDefinition>
}

function buildPipelineGraph(pipeline: PipelineSummary): BuiltGraph {
  const datasets = new Map<string, DatasetDefinition>()
  const datasetProducer = new Map<string, string>() // datasetId -> stepId

  for (const node of pipeline.graph.nodes) {
    const step = node.step
    datasets.set(step.output.id, step.output)
    datasetProducer.set(step.output.id, step.id)
    for (const input of step.inputs) {
      datasets.set(input.dataset.id, input.dataset)
    }
  }

  // Compute columns for layout
  const datasetColumn = new Map<string, number>()
  const stepColumn = new Map<string, number>()

  for (const datasetId of datasets.keys()) {
    if (!datasetProducer.has(datasetId)) {
      datasetColumn.set(datasetId, 0)
    }
  }

  for (const node of pipeline.graph.nodes) {
    const step = node.step
    const inputCols = step.inputs.map((input) => datasetColumn.get(input.dataset.id) ?? 0)
    const stepCol = (inputCols.length === 0 ? 0 : Math.max(...inputCols)) + 1
    stepColumn.set(step.id, stepCol)
    const existingOutCol = datasetColumn.get(step.output.id)
    const outCol = stepCol + 1
    if (existingOutCol === undefined || existingOutCol < outCol) {
      datasetColumn.set(step.output.id, outCol)
    }
  }

  // Group items per column for vertical stacking
  const columnContents = new Map<number, { dataset: string[]; step: string[] }>()
  const ensureColumn = (col: number) => {
    let entry = columnContents.get(col)
    if (!entry) {
      entry = { dataset: [], step: [] }
      columnContents.set(col, entry)
    }
    return entry
  }
  for (const [datasetId, col] of datasetColumn) {
    ensureColumn(col).dataset.push(datasetId)
  }
  for (const [stepId, col] of stepColumn) {
    ensureColumn(col).step.push(stepId)
  }

  const nodes: PipelineGraphFlowNode[] = []
  const sortedColumns = [...columnContents.keys()].sort((a, b) => a - b)
  const maxRows = Math.max(
    1,
    ...sortedColumns.map((col) => {
      const c = columnContents.get(col)!
      return c.dataset.length + c.step.length
    })
  )

  for (const col of sortedColumns) {
    const entry = columnContents.get(col)!
    const items: Array<{ kind: GraphNodeKind; id: string }> = [
      ...entry.step.map((id) => ({ kind: "step" as const, id })),
      ...entry.dataset.map((id) => ({ kind: "dataset" as const, id })),
    ]
    items.sort((a, b) => {
      if (a.kind === b.kind) return a.id.localeCompare(b.id)
      return a.kind === "step" ? -1 : 1
    })

    items.forEach((item, indexInCol) => {
      const x = col * STEP_GAP_X
      const y = (indexInCol - (items.length - 1) / 2) * ROW_GAP_Y + (maxRows * ROW_GAP_Y) / 2

      if (item.kind === "dataset") {
        const def = datasets.get(item.id)
        if (!def) return
        nodes.push({
          id: `dataset:${item.id}`,
          type: "dataset",
          position: { x, y },
          data: {
            kind: "dataset",
            datasetId: item.id,
            columnCount: def.schema.columns.length,
            description: def.description,
          },
          draggable: true,
        })
      } else {
        const stepNode = pipeline.graph.nodes.find((n) => n.step.id === item.id)
        if (!stepNode) return
        const step = stepNode.step
        nodes.push({
          id: `step:${item.id}`,
          type: "step",
          position: { x, y },
          data: {
            kind: "step",
            stepId: step.id,
            executor: executorLabel(step),
            mode: step.mode,
          },
          draggable: true,
        })
      }
    })
  }

  const edges: XYEdge[] = []
  for (const node of pipeline.graph.nodes) {
    const step = node.step
    for (const input of step.inputs) {
      edges.push({
        id: `e:${input.dataset.id}->${step.id}`,
        source: `dataset:${input.dataset.id}`,
        target: `step:${step.id}`,
        animated: false,
        style: { stroke: "var(--border-strong, #94a3b8)", strokeWidth: 1.25 },
      })
    }
    edges.push({
      id: `e:${step.id}->${step.output.id}`,
      source: `step:${step.id}`,
      target: `dataset:${step.output.id}`,
      animated: false,
      style: { stroke: "var(--border-strong, #94a3b8)", strokeWidth: 1.25 },
    })
  }

  return { nodes, edges, datasets }
}

function DatasetGraphCard({ data, selected }: NodeProps<DatasetGraphNode>) {
  return (
    <div
      className={cn(
        "min-w-[160px] max-w-[220px] cursor-pointer rounded-xl border border-border bg-card px-3 py-2 shadow-sm  transition-all hover:border-border",
        selected ? "ring-2 ring-primary/40" : ""
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
      <div className="flex items-center gap-1.5">
        <Database className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Dataset
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[13px] font-medium text-foreground">
        {data.datasetId}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {data.columnCount} column{data.columnCount === 1 ? "" : "s"}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
    </div>
  )
}

function StepGraphCard({ data, selected }: NodeProps<StepGraphNode>) {
  return (
    <div
      className={cn(
        "min-w-[160px] max-w-[220px] rounded-xl border border-border bg-muted px-3 py-2 shadow-sm  transition-all dark:bg-muted",
        selected ? "ring-2 ring-foreground/20" : ""
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
      <div className="flex items-center gap-1.5">
        <FunctionSquare className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Step
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[12px] text-foreground">{data.stepId}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {data.executor} · {data.mode}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
    </div>
  )
}

const nodeTypes = {
  dataset: DatasetGraphCard,
  step: StepGraphCard,
} as unknown as NodeTypes

function PipelineCanvas({
  pipeline,
  selectedDatasetId,
  onDatasetSelect,
  drawerOpen,
}: {
  pipeline: PipelineSummary
  selectedDatasetId: string | null
  onDatasetSelect: (datasetId: string | null) => void
  drawerOpen: boolean
}) {
  const built = useMemo(() => buildPipelineGraph(pipeline), [pipeline])
  const [nodes, setNodes, onNodesChange] = useNodesState<PipelineGraphFlowNode>(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<XYEdge>(built.edges)
  const { fitView } = useReactFlow()

  useEffect(() => {
    setNodes(built.nodes)
    setEdges(built.edges)
  }, [built, setNodes, setEdges])

  useEffect(() => {
    setNodes((current) =>
      current.map((node) =>
        node.type === "dataset"
          ? { ...node, selected: node.data.datasetId === selectedDatasetId }
          : { ...node, selected: false }
      )
    )
  }, [selectedDatasetId, setNodes])

  // When the drawer pushes the canvas, re-fit once the height transition settles.
  useEffect(() => {
    const padding = drawerOpen ? 0.18 : 0.25
    const timer = setTimeout(() => {
      fitView({ duration: 320, padding, maxZoom: 1.1 })
    }, 320)
    return () => clearTimeout(timer)
  }, [drawerOpen, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => {
        if (node.type === "dataset") {
          const datasetId = (node.data as DatasetNodeData).datasetId
          onDatasetSelect(selectedDatasetId === datasetId ? null : datasetId)
        }
      }}
      onPaneClick={() => onDatasetSelect(null)}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      panOnScroll
      zoomOnPinch
      nodesConnectable={false}
      defaultEdgeOptions={{
        type: "smoothstep",
        style: { stroke: "rgb(148 163 184 / 0.55)", strokeWidth: 1.25 },
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-50" />
      <Controls
        className="!rounded-xl !border !border-border !bg-card !shadow-sm !"
        showInteractive={false}
      />
    </ReactFlow>
  )
}

function RunsFloatingPanel({
  pipelineId,
  open,
  onClose,
}: {
  pipelineId: string
  open: boolean
  onClose: () => void
}) {
  const runsQuery = useQuery({
    ...listPipelineRunsOptions({
      query: { pipelineId, limit: "20", order: "desc" },
    }),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  })

  if (!open) return null

  const runs = runsQuery.data?.runs ?? []

  return (
    <div className="pointer-events-auto absolute right-4 top-16 z-20 w-[320px] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-none ">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">Runs</span>
          {runs.length > 0 && (
            <Badge variant="secondary" className="bg-muted text-[10px]">
              {runs.length}
            </Badge>
          )}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} className="-mr-1.5">
          <X />
        </Button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {runsQuery.isLoading ? (
          <div className="px-4 py-8">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading runs...</span>
            </div>
          </div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No runs yet. Trigger one with the Run button.
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {runs.map((run) => (
              <li key={run.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-foreground">{run.id}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatRelativeTime(run.startedAt)} · {runDuration(run)}
                    </p>
                    {run.error && (
                      <p className="mt-1 break-words text-[11px] text-destructive">
                        {run.error.name ? `${run.error.name}: ` : ""}
                        {run.error.message}
                      </p>
                    )}
                  </div>
                  <RunStatusBadge status={run.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const ROW_PREVIEW_LIMIT = 25

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatRowCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function DatasetPreviewDrawer({
  datasetId,
  open,
  onClose,
}: {
  datasetId: string | null
  open: boolean
  onClose: () => void
}) {
  const enabled = open && !!datasetId
  const id = datasetId ?? ""

  const datasetQuery = useQuery({
    ...getDatasetOptions({ path: { datasetId: id } }),
    enabled,
  })
  const rowsQuery = useQuery({
    ...listDatasetRowsOptions({
      path: { datasetId: id },
      query: { limit: String(ROW_PREVIEW_LIMIT) },
    }),
    enabled,
  })

  const dataset: GetDatasetResponse | undefined = datasetQuery.data
  const rowsData: ListDatasetRowsResponse | undefined = rowsQuery.data
  const columns = rowsData?.columns ?? dataset?.schema.columns.map((c) => c.name) ?? []
  const columnTypes = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of dataset?.schema.columns ?? []) {
      map.set(col.name, `${col.type}${col.nullable ? "?" : ""}`)
    }
    return map
  }, [dataset])

  const rows = rowsData?.rows ?? []
  const version = dataset?.latestVersion ?? rowsData?.version ?? null
  const error = (datasetQuery.error ?? rowsQuery.error) as { error?: string } | null
  const errorText =
    error && typeof error === "object" && "error" in error && typeof error.error === "string"
      ? error.error
      : null

  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden transition-[height] duration-300 ease-out",
        open ? "h-[55vh] max-h-[640px] min-h-[280px]" : "h-0"
      )}
      aria-hidden={!open}
    >
      <div className="flex h-full w-full flex-col border-t border-border bg-card ">
        {/* Drag handle (visual only) */}
        <div className="flex shrink-0 justify-center pt-2">
          <div className="h-1 w-10 rounded-full bg-muted-foreground/25" />
        </div>

        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-2 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Dataset
              </p>
            </div>
            <h2 className="mt-0.5 truncate font-mono text-base font-medium text-foreground">
              {datasetId ?? ""}
            </h2>
            {dataset?.description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{dataset.description}</p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close dataset preview"
          >
            <X />
          </Button>
        </div>

        {/* Stats strip */}
        <div className="grid shrink-0 grid-cols-2 gap-px overflow-hidden border-y border-border bg-border/40 sm:grid-cols-4">
          <div className="bg-card px-4 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Rows
            </p>
            <p className="mt-0.5 truncate text-sm text-foreground">
              {version?.rowCount !== undefined
                ? formatRowCount(version.rowCount)
                : rowsData?.total !== undefined
                  ? formatRowCount(rowsData.total)
                  : "—"}
            </p>
          </div>
          <div className="bg-card px-4 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Size
            </p>
            <p className="mt-0.5 truncate text-sm text-foreground">
              {version?.sizeBytes !== undefined ? formatBytes(version.sizeBytes) : "—"}
            </p>
          </div>
          <div className="bg-card px-4 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Columns
            </p>
            <p className="mt-0.5 truncate text-sm text-foreground">
              {dataset?.schema.columns.length ?? "—"}
            </p>
          </div>
          <div className="bg-card px-4 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Latest version
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-foreground">
              {version ? version.versionId : "—"}
            </p>
            {version && (
              <p className="truncate text-[10px] text-muted-foreground">
                {formatRelativeTime(version.createdAt)} · {version.mode}
              </p>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {datasetQuery.isLoading || rowsQuery.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Loading dataset...</span>
              </div>
            </div>
          ) : errorText ? (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                icon={<Rows3 className="h-9 w-9" />}
                title="Could not load preview"
                description={errorText}
                className="py-6"
              />
            </div>
          ) : columns.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                icon={<Rows3 className="h-9 w-9" />}
                title="No schema"
                description="This dataset has no declared columns."
                className="py-6"
              />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                icon={<Rows3 className="h-9 w-9" />}
                title="No rows yet"
                description="This dataset hasn't been materialized. Trigger a run to populate it."
                className="py-6"
              />
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column} className="font-mono normal-case first:pl-5 last:pr-5">
                      <div className="flex flex-col">
                        <span className="text-[11px] text-foreground">{column}</span>
                        {columnTypes.get(column) && (
                          <span className="text-[10px] text-muted-foreground">
                            {columnTypes.get(column)}
                          </span>
                        )}
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, rowIndex) => (
                  <TableRow key={`row-${rowIndex}`}>
                    {columns.map((column) => {
                      const raw = (row as Record<string, unknown>)[column]
                      const isNullish = raw === null || raw === undefined
                      return (
                        <TableCell
                          key={column}
                          className={cn(
                            "max-w-[320px] truncate whitespace-nowrap font-mono text-[11px] first:pl-5 last:pr-5",
                            isNullish ? "italic text-muted-foreground/60" : "text-foreground"
                          )}
                          title={formatCellValue(raw)}
                        >
                          {formatCellValue(raw)}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {rowsData && rows.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t border-border bg-background/40 px-5 py-2 text-[11px] text-muted-foreground">
            <span>
              Showing {rowsData.offset + 1}–{rowsData.offset + rows.length}
              {rowsData.total !== undefined ? ` of ${formatRowCount(rowsData.total)}` : ""}
            </span>
            {rowsData.hasMore && <span>Preview limited to {ROW_PREVIEW_LIMIT} rows</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export function PipelineDetailPage() {
  const { pipelineId = "" } = useParams()
  const navigate = useNavigate()
  const decodedPipelineId = decodeURIComponent(pipelineId)
  const [runsOpen, setRunsOpen] = useState(false)
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null)

  const pipelineQuery = useQuery({
    ...getPipelineOptions({ path: { pipelineId: decodedPipelineId } }),
    enabled: decodedPipelineId.length > 0,
  })

  const requestRun = useMutation(requestPipelineRunMutation())
  const pipeline = pipelineQuery.data

  const handleRequestRun = () => {
    requestRun.mutate(
      { path: { pipelineId: decodedPipelineId } },
      {
        onSuccess: () => {
          setRunsOpen(true)
          void pipelineQuery.refetch()
        },
      }
    )
  }

  if (pipelineQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading pipeline...</span>
        </div>
      </div>
    )
  }

  if (pipelineQuery.isError || !pipeline) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/pipelines")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Pipelines
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<Workflow className="h-10 w-10" />}
            title="Pipeline not found"
            description="This pipeline is not registered in the active Pario runtime."
          />
        </div>
      </div>
    )
  }

  const drawerOpen = selectedDatasetId !== null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ReactFlowProvider>
        <div className="relative min-h-0 flex-1">
          <PipelineCanvas
            pipeline={pipeline}
            selectedDatasetId={selectedDatasetId}
            onDatasetSelect={setSelectedDatasetId}
            drawerOpen={drawerOpen}
          />

          {/* Floating header */}
          <div className="pointer-events-none absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start justify-between gap-3">
            <div className="pointer-events-auto min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm ">
              <div className="flex items-center gap-3 px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => navigate("/pipelines")}
                  aria-label="Back to pipelines"
                >
                  <ChevronLeft />
                </Button>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pipeline
                  </p>
                  <h1 className="truncate text-sm font-medium text-foreground">
                    {pipelineName(pipeline)}
                  </h1>
                </div>
                {pipeline.latestRun && (
                  <div className="ml-1 hidden shrink-0 border-l border-border pl-3 sm:block">
                    <RunStatusBadge status={pipeline.latestRun.status} />
                  </div>
                )}
              </div>
              {(pipeline.graph.nodes.length > 0 || pipeline.triggers.length > 0) && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background/30 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span>{pipelineSummary(pipeline)}</span>
                  {pipeline.triggers.map((trigger) => (
                    <span
                      key={triggerLabel(trigger)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5"
                    >
                      <Clock3 className="h-3 w-3" />
                      {triggerLabel(trigger)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card p-1.5 shadow-sm ">
              <Button
                type="button"
                variant={runsOpen ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setRunsOpen((open) => !open)}
                aria-expanded={runsOpen}
              >
                <History />
                Runs
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleRequestRun}
                disabled={requestRun.isPending}
              >
                {requestRun.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
                Run
              </Button>
            </div>
          </div>

          <RunsFloatingPanel
            pipelineId={decodedPipelineId}
            open={runsOpen}
            onClose={() => setRunsOpen(false)}
          />

          {requestRun.error && (
            <div className="pointer-events-auto absolute bottom-4 right-4 z-10 max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-sm ">
              {errorMessage(requestRun.error)}
            </div>
          )}
        </div>

        <DatasetPreviewDrawer
          datasetId={selectedDatasetId}
          open={drawerOpen}
          onClose={() => setSelectedDatasetId(null)}
        />
      </ReactFlowProvider>
    </div>
  )
}
