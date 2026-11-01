// Loaded only when a pipeline page opens, so React Flow's code stays out of every other page's
// bundle. Its stylesheet, canvas.css, is part of the framework's.
import type { GetPipelineResponse } from "@sixb/client"
import { cn } from "@sixb/ui/lib/utils"
import {
  Controls,
  type Edge,
  getViewportForBounds,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react"
import { Braces, Database, FileCode2, type LucideIcon } from "lucide-react"
import { useEffect, useMemo } from "react"
import { humanize, type RunStatus, useRunStatusLabels } from "../../section-ui"
import { useDataMessages } from "./messages"

type Step = GetPipelineResponse["graph"]["nodes"][number]["step"]

interface DatasetNodeData extends Record<string, unknown> {
  readonly datasetId: string
  readonly columnCount: number
  readonly selected: boolean
}

interface StepNodeData extends Record<string, unknown> {
  readonly step: Step
  readonly status: RunStatus | null
}

type DatasetNode = Node<DatasetNodeData, "dataset">
type StepNode = Node<StepNodeData, "step">
type PipelineNode = DatasetNode | StepNode

const columnGap = 280
const rowGap = 128

interface PipelineCanvasProps {
  readonly pipeline: GetPipelineResponse
  /** Each step's status in the run being shown. */
  readonly stepStatus: ReadonlyMap<string, RunStatus>
  readonly selectedDatasetId: string | null
  readonly onSelectDataset: (datasetId: string | null) => void
}

export default function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ pipeline, stepStatus, selectedDatasetId, onSelectDataset }: PipelineCanvasProps) {
  const graph = useMemo(() => layoutPipeline(pipeline), [pipeline])
  const { getNodes, getNodesBounds, setViewport } = useReactFlow()

  const nodes = useMemo(
    () =>
      graph.nodes.map((node) =>
        node.type === "dataset"
          ? { ...node, data: { ...node.data, selected: node.data.datasetId === selectedDatasetId } }
          : { ...node, data: { ...node.data, status: stepStatus.get(node.data.step.id) ?? null } }
      ),
    [graph, selectedDatasetId, stepStatus]
  )

  // The dataset drawer and the runs panel resize the canvas as they slide; fit once it settles.
  // The viewport is set from the nodes' bounds: React Flow's own fitView waits for a node change
  // that a resize never brings.
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  useEffect(() => {
    if (width === 0 || height === 0) return
    const timer = window.setTimeout(() => {
      const nodes = getNodes()
      if (nodes.length === 0) return
      const viewport = getViewportForBounds(
        getNodesBounds(nodes),
        width,
        height,
        minZoom,
        fitOptions.maxZoom,
        fitOptions.padding
      )
      void setViewport(viewport, { duration: 200 })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [width, height, getNodes, getNodesBounds, setViewport])

  return (
    <ReactFlow<PipelineNode>
      nodes={nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => {
        if (node.type !== "dataset") return
        const { datasetId } = node.data
        onSelectDataset(selectedDatasetId === datasetId ? null : datasetId)
      }}
      onPaneClick={() => onSelectDataset(null)}
      fitView
      fitViewOptions={fitOptions}
      minZoom={minZoom}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      proOptions={{ hideAttribution: true }}
      className="sixb-canvas"
    >
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  )
}

// Handles anchor the edges; drawn, they read as stray dots on every card.
const handleClass = "!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"

function DatasetCard({ data }: NodeProps<DatasetNode>) {
  const messages = useDataMessages()
  return (
    <div
      className={cn(
        "w-52 cursor-pointer rounded-xl border bg-card px-3 py-2 transition-colors",
        data.selected ? "border-[#007aff]" : "border-border hover:border-foreground/25"
      )}
    >
      <Handle type="target" position={Position.Left} className={handleClass} />
      <NodeKind icon={Database} label={messages.pipelines.nodeDataset} />
      <p className="mt-1 truncate font-mono text-[0.8125rem] font-medium text-foreground">
        {data.datasetId}
      </p>
      <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
        {messages.common.columns(data.columnCount)}
      </p>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  )
}

// A step that did not succeed says so; one that did needs no mark.
const statusText: Partial<Record<RunStatus, string>> = {
  queued: "text-muted-foreground",
  running: "text-[#007aff]",
  failed: "text-red-600 dark:text-red-400",
  cancelled: "text-muted-foreground",
}

function StepCard({ data }: NodeProps<StepNode>) {
  const messages = useDataMessages()
  const statusLabels = useRunStatusLabels()
  const { step, status } = data
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-muted px-3 py-2",
        status === "failed" ? "border-red-500/50" : "border-border"
      )}
    >
      <Handle type="target" position={Position.Left} className={handleClass} />
      <div className="flex items-center justify-between gap-2">
        <NodeKind
          icon={step.executor.kind === "sql" ? FileCode2 : Braces}
          label={messages.pipelines.nodeStep}
        />
        {status && statusText[status] ? (
          <span className={cn("text-[0.6875rem] font-medium", statusText[status])}>
            {statusLabels[status]}
          </span>
        ) : null}
      </div>
      <p className="mt-1 truncate text-[0.8125rem] font-medium text-foreground">
        {humanize(step.id)}
      </p>
      <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
        {messages.pipelines.executors[step.executor.kind]} · {messages.common.modes[step.mode]}
      </p>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  )
}

function NodeKind({ icon: Icon, label }: { readonly icon: LucideIcon; readonly label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
      <Icon className="size-3" />
      {label}
    </span>
  )
}

const minZoom = 0.3
const fitOptions = { padding: 0.15, maxZoom: 1 }

const nodeTypes = { dataset: DatasetCard, step: StepCard } satisfies NodeTypes

/**
 * Columns from left to right: datasets nothing in the pipeline writes, then each step one column
 * past its furthest input, then its output one past the step.
 */
export function layoutPipeline(pipeline: GetPipelineResponse): {
  readonly nodes: PipelineNode[]
  readonly edges: Edge[]
} {
  const steps = pipeline.graph.nodes.map((node) => node.step)
  const datasets = new Map<string, number>()
  const written = new Set(steps.map((step) => step.output.id))
  for (const step of steps) {
    for (const input of step.inputs) {
      if (!written.has(input.dataset.id)) datasets.set(input.dataset.id, 0)
    }
  }
  const columnCounts = new Map<string, number>()
  for (const step of steps) {
    for (const dataset of [...step.inputs.map((input) => input.dataset), step.output]) {
      columnCounts.set(dataset.id, dataset.schema.columns.length)
    }
  }

  const stepColumn = new Map<string, number>()
  for (const step of steps) {
    const column =
      Math.max(0, ...step.inputs.map((input) => datasets.get(input.dataset.id) ?? 0)) + 1
    stepColumn.set(step.id, column)
    datasets.set(step.output.id, Math.max(datasets.get(step.output.id) ?? 0, column + 1))
  }

  const columns = new Map<number, { kind: "dataset" | "step"; id: string }[]>()
  const place = (column: number, item: { kind: "dataset" | "step"; id: string }) =>
    columns.set(column, [...(columns.get(column) ?? []), item])
  for (const [id, column] of datasets) place(column, { kind: "dataset", id })
  for (const [id, column] of stepColumn) place(column, { kind: "step", id })

  const tallest = Math.max(1, ...[...columns.values()].map((items) => items.length))
  const nodes: PipelineNode[] = []
  for (const [column, items] of columns) {
    items.forEach((item, index) => {
      const position = {
        x: column * columnGap,
        y: (index - (items.length - 1) / 2) * rowGap + ((tallest - 1) * rowGap) / 2,
      }
      if (item.kind === "dataset") {
        nodes.push({
          id: `dataset:${item.id}`,
          type: "dataset",
          position,
          data: {
            datasetId: item.id,
            columnCount: columnCounts.get(item.id) ?? 0,
            selected: false,
          },
        })
      } else {
        const step = steps.find((candidate) => candidate.id === item.id)
        if (step) {
          nodes.push({
            id: `step:${step.id}`,
            type: "step",
            position,
            data: { step, status: null },
          })
        }
      }
    })
  }

  const edge = (source: string, target: string): Edge => ({
    id: `${source}->${target}`,
    source,
    target,
    type: "smoothstep",
    style: { stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeWidth: 1 },
  })
  const edges = steps.flatMap((step) => [
    ...step.inputs.map((input) => edge(`dataset:${input.dataset.id}`, `step:${step.id}`)),
    edge(`step:${step.id}`, `dataset:${step.output.id}`),
  ])

  return { nodes, edges }
}
