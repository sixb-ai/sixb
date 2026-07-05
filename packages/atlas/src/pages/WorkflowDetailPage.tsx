import { client } from "@sixb/client"
import {
  getWorkflowOptions,
  getWorkflowRunOptions,
  listWorkflowRunsOptions,
} from "@sixb/client/hooks"
import { Badge, Button, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
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
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  CalendarClock,
  Check,
  ChevronLeft,
  Copy,
  Crosshair,
  GitBranch,
  History,
  Loader2,
  Play,
  SlidersHorizontal,
  UserCheck,
  Webhook,
  Workflow,
  X,
  Zap,
} from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { StructuredValue } from "../components/StructuredValue"
import { SchemaShape } from "../features/workflows/components/nodes/SchemaShape"
import { WorkflowInterventionPanel } from "../features/workflows/components/nodes/WorkflowInterventionPanel"
import { RequestWorkflowRunDialog } from "../features/workflows/components/RequestWorkflowRunDialog"
import { RunProgress } from "../features/workflows/components/runs/RunProgress"
import {
  NodeStatusBadge,
  StatusBadge,
  WorkflowRunStatusIcon,
} from "../features/workflows/components/runs/StatusBadge"
import { useWorkflowLiveUpdates } from "../features/workflows/hooks/useWorkflowLiveUpdates"
import {
  formatDate,
  formatNodeDuration,
  formatRelativeTime,
  formatRunDuration,
  formatRunStartedDate,
  isActiveRunStatus,
  runTimeLabel,
  type WorkflowDetail,
  type WorkflowNode,
  type WorkflowNodeStatus,
  type WorkflowRunDetail,
  type WorkflowRunNode,
  type WorkflowRunStatus,
} from "../features/workflows/utils/workflows"
import { workflowNodeFileContentUrl, workflowRunFileContentUrl } from "../lib/files"

type WorkflowTrigger = WorkflowDetail["triggers"][number]

// --------------------------------------------------------------------------
// Page
// --------------------------------------------------------------------------

export function WorkflowDetailPage() {
  const { workflowId = "" } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Panel state lives in the URL so runs are deep-linkable and the browser's
  // back/forward buttons move between views.
  const activeRunId = searchParams.get("run")
  const selectedNodeId = searchParams.get("node")
  const runsListOpen = searchParams.get("tab") === "runs"

  useWorkflowLiveUpdates({ workflowId, enabled: workflowId.length > 0 })

  const workflowQuery = useQuery({
    ...getWorkflowOptions({ path: { workflowId } }),
    enabled: workflowId.length > 0,
  })

  const runQuery = useQuery({
    ...getWorkflowRunOptions({ path: { runId: activeRunId ?? "" } }),
    enabled: activeRunId !== null,
  })
  const runDetail = activeRunId ? runQuery.data : undefined
  useWorkflowLiveUpdates({
    runId: activeRunId ?? undefined,
    enabled: activeRunId !== null && (runDetail ? isActiveRunStatus(runDetail.run.status) : true),
  })

  const runNodesByFlowId = useMemo(() => {
    const map = new Map<string, WorkflowRunNode>()
    for (const node of runDetail?.nodes ?? []) {
      map.set(`node:${node.nodeId}`, node)
    }
    return map
  }, [runDetail])

  const runStatusByFlowId = useMemo(() => {
    if (!runDetail) return null
    const map = new Map<string, WorkflowNodeStatus>()
    for (const [id, node] of runNodesByFlowId) {
      map.set(id, node.status)
    }
    return map
  }, [runDetail, runNodesByFlowId])

  if (!workflowId) {
    return <Navigate to="/workflows" replace />
  }

  if (workflowQuery.isLoading) {
    return <CenteredLoader label="Loading workflow..." />
  }

  if (workflowQuery.isError || !workflowQuery.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 p-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/workflows")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Workflows
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<GitBranch className="h-10 w-10" />}
            title="Workflow unavailable"
            description="Could not load workflow metadata."
          />
        </div>
      </div>
    )
  }

  const workflow = workflowQuery.data
  const latestRun = workflow.latestRun

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        mutate(next)
        return next
      },
      { replace: false }
    )
  }

  const closeAll = () =>
    updateParams((p) => {
      p.delete("run")
      p.delete("node")
      p.delete("tab")
    })
  const selectRun = (runId: string) =>
    updateParams((p) => {
      p.set("run", runId)
      p.delete("node")
      p.delete("tab")
    })
  const backToRunsList = () =>
    updateParams((p) => {
      p.delete("run")
      p.delete("node")
      p.set("tab", "runs")
    })
  const toggleRunsList = () =>
    updateParams((p) => {
      p.delete("node")
      if (p.get("run")) {
        p.delete("run")
        p.set("tab", "runs")
        return
      }
      if (p.get("tab") === "runs") p.delete("tab")
      else p.set("tab", "runs")
    })
  const handleSelect = (id: string | null) =>
    updateParams((p) => {
      p.delete("tab")
      if (id === null || p.get("node") === id) p.delete("node")
      else p.set("node", id)
    })
  const closeNode = () => updateParams((p) => p.delete("node"))
  const closeRunsList = () => updateParams((p) => p.delete("tab"))

  const panelContent = renderPanel({
    workflow,
    activeRunId,
    runQuery: { isLoading: runQuery.isLoading, isError: runQuery.isError, data: runDetail },
    runNodesByFlowId,
    selectedNodeId,
    runsListOpen,
    onSelectRun: selectRun,
    onBackToRuns: backToRunsList,
    onClose: closeAll,
    onCloseNode: closeNode,
    onCloseRunsList: closeRunsList,
  })
  const panelOpen = panelContent !== null
  const runsActive = runsListOpen || activeRunId !== null

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ReactFlowProvider>
        <div className="relative min-w-0 flex-1">
          <WorkflowCanvas
            workflow={workflow}
            selectedNodeId={selectedNodeId}
            runStatusByFlowId={runStatusByFlowId}
            onSelect={handleSelect}
            panelOpen={panelOpen}
          />

          {/* Floating header */}
          <div className="pointer-events-none absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start justify-between gap-3">
            <div className="pointer-events-auto min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              <div className="flex items-center gap-3 px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => navigate("/workflows")}
                  aria-label="Back to workflows"
                >
                  <ChevronLeft />
                </Button>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Workflow
                  </p>
                  <h1 className="truncate text-sm font-medium text-foreground">{workflow.id}</h1>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-background/30 px-3 py-1.5 text-[11px] text-muted-foreground">
                {activeRunId && runDetail ? (
                  <>
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <span
                        className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[runDetail.run.status])}
                      />
                      Viewing run
                      <span className="font-mono text-muted-foreground">
                        {shortRunId(runDetail.run.id)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={closeAll}
                      className="border-l border-border pl-3 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Exit run view
                    </button>
                  </>
                ) : (
                  <>
                    <span>{summaryLine(workflow)}</span>
                    {latestRun ? (
                      <button
                        type="button"
                        onClick={() => selectRun(latestRun.id)}
                        className="inline-flex items-center gap-1 border-l border-border pl-3 text-muted-foreground hover:text-foreground"
                      >
                        <History className="h-3 w-3" />
                        {runTimeLabel(latestRun)}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card p-1.5 shadow-sm">
              <Button
                type="button"
                variant={runsActive ? "secondary" : "ghost"}
                size="sm"
                onClick={toggleRunsList}
                aria-expanded={runsActive}
              >
                <History />
                Runs
              </Button>
              <RequestWorkflowRunDialog workflow={workflow} />
            </div>
          </div>
        </div>

        <WorkflowSidePanel open={panelOpen}>{panelContent}</WorkflowSidePanel>
      </ReactFlowProvider>
    </div>
  )
}

function summaryLine(workflow: WorkflowDetail): string {
  const nodeCount = workflow.nodes.length
  const triggerCount = workflow.triggers.length
  const inputCount = fieldCount(workflow.input)
  return [
    `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`,
    `${triggerCount} ${triggerCount === 1 ? "trigger" : "triggers"}`,
    `${inputCount} input ${inputCount === 1 ? "field" : "fields"}`,
  ].join(" · ")
}

function shortRunId(runId: string): string {
  const withoutPrefix = runId.startsWith("run_") ? runId.slice(4) : runId
  if (withoutPrefix.length <= 17) return withoutPrefix
  return `${withoutPrefix.slice(0, 8)}…${withoutPrefix.slice(-6)}`
}

function CenteredLoader({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center py-24">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Graph model
// --------------------------------------------------------------------------

const NODE_GAP_Y = 132

interface BaseNodeData extends Record<string, unknown> {
  runStatus?: WorkflowNodeStatus
  runActive?: boolean
}
interface StartNodeData extends BaseNodeData {
  kind: "start"
  inputCount: number
}
interface StepNodeData extends BaseNodeData {
  kind: "step"
  index: number
  label: string
  inputCount: number
  outputCount: number
}
interface ActionNodeData extends BaseNodeData {
  kind: "action"
  index: number
  label: string
  global: boolean
  scopeLabel: string
}
interface InterventionNodeData extends BaseNodeData {
  kind: "intervention"
  index: number
  label: string
  inputCount: number
  responseCount: number
}

type WorkflowNodeData = StartNodeData | StepNodeData | ActionNodeData | InterventionNodeData
type WorkflowFlowNode = Node<WorkflowNodeData>

function fieldCount(shape: Readonly<Record<string, unknown>> | undefined): number {
  return Object.keys(shape ?? {}).length
}

function toNodeData(node: WorkflowNode, index: number): WorkflowNodeData {
  if (node.type === "action") {
    const global = node.objectTypeId === undefined
    return {
      kind: "action",
      index,
      label: node.key,
      global,
      scopeLabel: node.objectTypeId ?? "global",
    }
  }
  if (node.type === "intervention") {
    return {
      kind: "intervention",
      index,
      label: node.key,
      inputCount: fieldCount(node.input),
      responseCount: fieldCount(node.response),
    }
  }
  return {
    kind: "step",
    index,
    label: node.key,
    inputCount: fieldCount(node.input),
    outputCount: fieldCount(node.output),
  }
}

function buildWorkflowGraph(workflow: WorkflowDetail): {
  nodes: WorkflowFlowNode[]
  edges: XYEdge[]
} {
  const nodes: WorkflowFlowNode[] = [
    {
      id: "start",
      type: "wf",
      position: { x: 0, y: 0 },
      data: {
        kind: "start",
        inputCount: fieldCount(workflow.input),
      },
      draggable: true,
    },
  ]
  const edges: XYEdge[] = []

  workflow.nodes.forEach((node, index) => {
    const id = `node:${node.id}`
    nodes.push({
      id,
      type: "wf",
      position: { x: 0, y: (index + 1) * NODE_GAP_Y },
      data: toNodeData(node, index),
      draggable: true,
    })
    const sourceId = index === 0 ? "start" : `node:${workflow.nodes[index - 1].id}`
    edges.push({ id: `e:${sourceId}->${id}`, source: sourceId, target: id })
  })

  return { nodes, edges }
}

// --------------------------------------------------------------------------
// Canvas
// --------------------------------------------------------------------------

const RUN_ACCENT: Record<WorkflowNodeStatus, string> = {
  running: "border-amber-500/60",
  waiting: "border-violet-500/60",
  succeeded: "border-emerald-500/60",
  failed: "border-red-500/60",
  cancelled: "border-zinc-500/50",
}
const RUN_ICON_COLOR: Record<WorkflowNodeStatus, string> = {
  running: "text-amber-500",
  waiting: "text-violet-500",
  succeeded: "text-emerald-500",
  failed: "text-red-500",
  cancelled: "text-zinc-500",
}
const STATUS_DOT: Record<WorkflowRunStatus, string> = {
  queued: "bg-sky-500",
  running: "bg-amber-500",
  waiting: "bg-violet-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-zinc-500",
}

function WorkflowFlowCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const isStart = data.kind === "start"
  const runStatus = data.runStatus
  const dimmed = Boolean(data.runActive) && !runStatus && !isStart

  return (
    <div
      className={cn(
        "w-[190px] cursor-pointer rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all hover:border-foreground/20",
        runStatus ? RUN_ACCENT[runStatus] : "border-border",
        dimmed && "opacity-55",
        selected && "border-primary/50 ring-2 ring-primary/30"
      )}
    >
      {!isStart ? (
        <Handle
          type="target"
          position={Position.Top}
          className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
        />
      ) : null}

      <div className="flex items-center gap-1.5">
        <NodeKindIcon kind={data.kind} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {kindLabel(data.kind)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {runStatus ? (
            <span className={RUN_ICON_COLOR[runStatus]}>
              <WorkflowRunStatusIcon status={runStatus} />
            </span>
          ) : null}
          {!isStart ? (
            <span className="rounded bg-muted px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
              {data.index + 1}
            </span>
          ) : null}
        </span>
      </div>

      <p className="mt-1.5 truncate text-[13px] font-medium text-foreground">{cardTitle(data)}</p>
      <NodeMetaLine data={data} />

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
    </div>
  )
}

function NodeMetaLine({ data }: { data: WorkflowNodeData }) {
  if (data.kind === "start") {
    return (
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {data.inputCount} input {data.inputCount === 1 ? "field" : "fields"}
      </p>
    )
  }
  if (data.kind === "action") {
    return (
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span>{data.global ? "scope" : "targets"}</span>
        <span className="inline-flex min-w-0 items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5 font-medium text-foreground">
          <Box className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate">{data.scopeLabel}</span>
        </span>
      </p>
    )
  }
  if (data.kind === "intervention") {
    return (
      <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
        {data.inputCount} in · {data.responseCount} resp
      </p>
    )
  }
  return (
    <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
      {data.inputCount} in · {data.outputCount} out
    </p>
  )
}

function cardTitle(data: WorkflowNodeData): string {
  return data.kind === "start" ? "Workflow input" : data.label
}

function kindLabel(kind: WorkflowNodeData["kind"]): string {
  if (kind === "start") return "Start"
  if (kind === "action") return "Action"
  if (kind === "intervention") return "Human"
  return "Step"
}

function NodeKindIcon({ kind }: { kind: WorkflowNodeData["kind"] }) {
  const className = "h-3 w-3 text-muted-foreground"
  if (kind === "start") return <Play className={className} />
  if (kind === "action") return <Zap className={className} />
  if (kind === "intervention") return <UserCheck className={className} />
  return <Workflow className={className} />
}

const nodeTypes = { wf: WorkflowFlowCard } as unknown as NodeTypes

function WorkflowCanvas({
  workflow,
  selectedNodeId,
  runStatusByFlowId,
  onSelect,
  panelOpen,
}: {
  workflow: WorkflowDetail
  selectedNodeId: string | null
  runStatusByFlowId: Map<string, WorkflowNodeStatus> | null
  onSelect: (id: string | null) => void
  panelOpen: boolean
}) {
  const built = useMemo(() => buildWorkflowGraph(workflow), [workflow])
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<XYEdge>(built.edges)
  const { fitView } = useReactFlow()

  // Edges only depend on the graph shape.
  useEffect(() => {
    setEdges(built.edges)
  }, [built, setEdges])

  // Rebuild nodes from the graph while preserving dragged positions, and apply
  // selection + run-status decorations.
  useEffect(() => {
    setNodes((current) => {
      const positionById = new Map(current.map((node) => [node.id, node.position]))
      return built.nodes.map((node) => ({
        ...node,
        position: positionById.get(node.id) ?? node.position,
        selected: node.id === selectedNodeId,
        data: {
          ...node.data,
          runStatus: runStatusByFlowId?.get(node.id),
          runActive: runStatusByFlowId != null,
        },
      }))
    })
  }, [built, selectedNodeId, runStatusByFlowId, setNodes])

  // Re-fit when the detail panel opens/closes so nodes stay in view.
  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ duration: 320, padding: panelOpen ? 0.2 : 0.28, maxZoom: 1.1 })
    }, 320)
    return () => clearTimeout(timer)
  }, [panelOpen, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
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
        className="!rounded-xl !border !border-border !bg-card !shadow-sm"
        showInteractive={false}
      />
    </ReactFlow>
  )
}

// --------------------------------------------------------------------------
// Side panel — shell + router
// --------------------------------------------------------------------------

function WorkflowSidePanel({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <aside
      className={cn(
        "h-full shrink-0 overflow-hidden border-l border-border bg-card transition-[width] duration-300 ease-out",
        open ? "w-[22rem] max-w-[calc(100vw-1rem)]" : "w-0"
      )}
      aria-hidden={!open}
    >
      <div className="flex h-full w-[22rem] max-w-[calc(100vw-1rem)] flex-col">{children}</div>
    </aside>
  )
}

type RunResult = { run: WorkflowRunDetail; nodes: readonly WorkflowRunNode[] }

function renderPanel(props: {
  workflow: WorkflowDetail
  activeRunId: string | null
  runQuery: { isLoading: boolean; isError: boolean; data: RunResult | undefined }
  runNodesByFlowId: Map<string, WorkflowRunNode>
  selectedNodeId: string | null
  runsListOpen: boolean
  onSelectRun: (runId: string) => void
  onBackToRuns: () => void
  onClose: () => void
  onCloseNode: () => void
  onCloseRunsList: () => void
}): ReactNode {
  const {
    workflow,
    activeRunId,
    runNodesByFlowId,
    selectedNodeId,
    runsListOpen,
    onSelectRun,
    onBackToRuns,
    onClose,
    onCloseNode,
    onCloseRunsList,
  } = props
  const runData = props.runQuery.data

  if (activeRunId) {
    if (props.runQuery.isLoading || !runData) {
      return (
        <>
          <PanelHeader
            icon={<History className={PANEL_ICON} />}
            eyebrow="Run"
            title={shortRunId(activeRunId)}
            copyValue={activeRunId}
            onBack={onBackToRuns}
            onClose={onClose}
          />
          <div className="flex flex-1 items-center justify-center">
            {props.runQuery.isError ? (
              <p className="px-6 text-center text-sm text-muted-foreground">
                Could not load this run.
              </p>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </div>
        </>
      )
    }

    if (selectedNodeId === "start") {
      return <RunStartPanel run={runData.run} onBack={onCloseNode} onClose={onClose} />
    }

    if (selectedNodeId) {
      const index = workflow.nodes.findIndex((node) => `node:${node.id}` === selectedNodeId)
      const definitionNode = index === -1 ? undefined : workflow.nodes[index]
      return (
        <RunNodePanel
          runNode={runNodesByFlowId.get(selectedNodeId)}
          definitionNode={definitionNode}
          index={index}
          onBack={onCloseNode}
          onClose={onClose}
        />
      )
    }

    return (
      <RunSummaryPanel
        run={runData.run}
        nodes={runData.nodes}
        totalSteps={workflow.nodes.length}
        onBack={onBackToRuns}
        onClose={onClose}
      />
    )
  }

  if (selectedNodeId) {
    const selection = resolveSelection(workflow, selectedNodeId)
    if (selection) {
      return <DefinitionNodePanel selection={selection} onClose={onCloseNode} />
    }
  }

  if (runsListOpen) {
    return (
      <RunsListPanel workflowId={workflow.id} onSelectRun={onSelectRun} onClose={onCloseRunsList} />
    )
  }

  return null
}

const PANEL_ICON = "h-3.5 w-3.5 text-muted-foreground"

function PanelHeader({
  icon,
  eyebrow,
  badge,
  title,
  description,
  copyValue,
  onBack,
  onClose,
}: {
  icon: ReactNode
  eyebrow: string
  badge?: ReactNode
  title: string
  description?: string
  /** When set, the title renders as a monospace identifier with a copy button. */
  copyValue?: string
  onBack?: () => void
  onClose: () => void
}) {
  return (
    <div className="flex items-start gap-2 border-b border-border px-3 py-3.5">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back"
          className="mt-0.5 shrink-0"
        >
          <ChevronLeft />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1 px-1">
        <div className="flex flex-wrap items-center gap-2">
          {icon}
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </span>
          {badge}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <h2
            className={cn(
              "min-w-0 truncate text-sm font-medium text-foreground",
              copyValue && "font-mono"
            )}
            title={copyValue ?? undefined}
          >
            {title}
          </h2>
          {copyValue ? <CopyButton value={copyValue} label="Copy run ID" /> : null}
        </div>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Close"
        className="-mr-1 shrink-0"
      >
        <X />
      </Button>
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; fail silently.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onCopy}
      aria-label={label}
      title={label}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy />}
    </Button>
  )
}

function PanelScroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-auto-hide">
      {children}
    </div>
  )
}

// --------------------------------------------------------------------------
// Definition node detail
// --------------------------------------------------------------------------

type Selection =
  | { kind: "start"; workflow: WorkflowDetail }
  | { kind: "node"; node: WorkflowNode; index: number }

function resolveSelection(
  workflow: WorkflowDetail,
  selectedNodeId: string | null
): Selection | null {
  if (!selectedNodeId) return null
  if (selectedNodeId === "start") return { kind: "start", workflow }
  const index = workflow.nodes.findIndex((node) => `node:${node.id}` === selectedNodeId)
  if (index === -1) return null
  return { kind: "node", node: workflow.nodes[index], index }
}

function DefinitionNodePanel({
  selection,
  onClose,
}: {
  selection: Selection
  onClose: () => void
}) {
  const header =
    selection.kind === "start"
      ? {
          title: "Workflow input",
          kind: "start" as const,
          description: "Data required before this workflow can run.",
        }
      : nodeHeader(selection.node)

  return (
    <>
      <PanelHeader
        icon={<NodeKindIcon kind={header.kind} />}
        eyebrow={kindLabel(header.kind)}
        badge={
          selection.kind === "node" ? (
            <Badge
              variant="secondary"
              className="rounded px-1.5 py-0 font-mono text-[10px] tabular-nums"
            >
              #{selection.index + 1}
            </Badge>
          ) : null
        }
        title={header.title}
        description={header.description}
        onClose={onClose}
      />
      <PanelScroll>
        {selection.kind === "start" ? (
          <StartPanelSections workflow={selection.workflow} />
        ) : (
          <NodePanelSections node={selection.node} />
        )}
      </PanelScroll>
    </>
  )
}

function nodeHeader(node: WorkflowNode): {
  title: string
  kind: WorkflowNodeData["kind"]
  description?: string
} {
  if (node.type === "action") {
    return {
      title: node.key,
      kind: "action",
      description:
        node.objectTypeId === undefined
          ? "Sends a global action request."
          : `Sends an action request to ${node.objectTypeId}.`,
    }
  }
  if (node.type === "intervention") {
    return {
      title: node.key,
      kind: "intervention",
      description: node.description ?? "Waits for a human response.",
    }
  }
  return { title: node.key, kind: "step", description: "Transforms workflow data." }
}

function StartPanelSections({ workflow }: { workflow: WorkflowDetail }) {
  return (
    <>
      <PanelBlock
        label="Input fields"
        count={fieldCount(workflow.input)}
        icon={<ArrowDownToLine className={SECTION_ICON} />}
      >
        <SchemaShape fields={workflow.input} emptyLabel="No input required" />
      </PanelBlock>
      <PanelBlock label="Start conditions" icon={<Zap className={SECTION_ICON} />}>
        {workflow.triggers.length === 0 ? (
          <div className="space-y-1">
            <p className="text-sm text-foreground">Manual or API start</p>
            <p className="text-xs text-muted-foreground">
              Runs begin when a person, app, or API invokes this workflow.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {workflow.triggers.map((trigger, index) => (
              <TriggerRow key={`${trigger.type}:${index}`} trigger={trigger} />
            ))}
          </ul>
        )}
      </PanelBlock>
    </>
  )
}

function NodePanelSections({ node }: { node: WorkflowNode }) {
  if (node.type === "action") {
    return (
      <>
        <PanelBlock label="Scope" icon={<Crosshair className={SECTION_ICON} />}>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs font-medium text-foreground">
            <Box className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            {node.objectTypeId ?? "global"}
          </span>
        </PanelBlock>
        <PanelBlock
          label="Params"
          count={fieldCount(node.params)}
          icon={<SlidersHorizontal className={SECTION_ICON} />}
        >
          <SchemaShape fields={node.params} emptyLabel="No params" />
        </PanelBlock>
      </>
    )
  }
  if (node.type === "intervention") {
    return (
      <>
        <PanelBlock
          label="Input"
          count={fieldCount(node.input)}
          icon={<ArrowDownToLine className={SECTION_ICON} />}
        >
          <SchemaShape fields={node.input} emptyLabel="No input fields" />
        </PanelBlock>
        <PanelBlock
          label="Response"
          count={fieldCount(node.response)}
          icon={<ArrowUpFromLine className={SECTION_ICON} />}
        >
          <SchemaShape fields={node.response} emptyLabel="No response fields" />
        </PanelBlock>
      </>
    )
  }
  return (
    <>
      <PanelBlock
        label="Input"
        count={fieldCount(node.input)}
        icon={<ArrowDownToLine className={SECTION_ICON} />}
      >
        <SchemaShape fields={node.input} emptyLabel="No input fields" />
      </PanelBlock>
      <PanelBlock
        label="Output"
        count={fieldCount(node.output)}
        icon={<ArrowUpFromLine className={SECTION_ICON} />}
      >
        <SchemaShape fields={node.output} emptyLabel="No output fields" />
      </PanelBlock>
    </>
  )
}

const SECTION_ICON = "h-3.5 w-3.5 text-muted-foreground"

function PanelBlock({
  label,
  count,
  icon,
  children,
}: {
  label: string
  count?: number
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background/30">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
        </div>
        {typeof count === "number" ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {count} {count === 1 ? "field" : "fields"}
          </span>
        ) : null}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  )
}

function TriggerRow({ trigger }: { trigger: WorkflowTrigger }) {
  const isSchedule = trigger.type === "schedule"
  return (
    <li className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        {isSchedule ? (
          <CalendarClock className="h-3.5 w-3.5" />
        ) : (
          <Webhook className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {isSchedule ? "Schedule" : trigger.type}
        </p>
        {isSchedule ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{trigger.scheduleId}</p>
        ) : null}
      </div>
    </li>
  )
}

// --------------------------------------------------------------------------
// Runs list panel
// --------------------------------------------------------------------------

function RunsListPanel({
  workflowId,
  onSelectRun,
  onClose,
}: {
  workflowId: string
  onSelectRun: (runId: string) => void
  onClose: () => void
}) {
  const runsQuery = useQuery(
    listWorkflowRunsOptions({ query: { workflowId, limit: "50", order: "desc" } })
  )
  const runs = runsQuery.data?.runs ?? []

  return (
    <>
      <PanelHeader
        icon={<History className={PANEL_ICON} />}
        eyebrow="Runs"
        badge={
          runs.length > 0 ? (
            <Badge variant="secondary" className="rounded px-1.5 py-0 text-[10px] tabular-nums">
              {runs.length}
            </Badge>
          ) : null
        }
        title="Run history"
        description="Select a run to inspect it on the canvas."
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-auto-hide">
        {runsQuery.isLoading ? (
          <div className="flex items-center gap-3 px-4 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading runs...</span>
          </div>
        ) : runsQuery.isError ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            Could not load runs for this workflow.
          </p>
        ) : runs.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No runs yet. Trigger one with the Run workflow button.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                  className="flex w-full items-start justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-foreground">{run.id}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {runTimeLabel(run)} · {formatRunDuration(run)}
                    </p>
                    {run.error ? (
                      <p className="mt-1 break-words text-[11px] text-destructive">{run.error}</p>
                    ) : null}
                  </div>
                  <StatusBadge status={run.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

// --------------------------------------------------------------------------
// Run summary + run node detail
// --------------------------------------------------------------------------

function RunSummaryPanel({
  run,
  nodes,
  totalSteps,
  onBack,
  onClose,
}: {
  run: WorkflowRunDetail
  nodes: readonly WorkflowRunNode[]
  totalSteps: number
  onBack: () => void
  onClose: () => void
}) {
  return (
    <>
      <PanelHeader
        icon={<History className={PANEL_ICON} />}
        eyebrow="Run"
        badge={<StatusBadge status={run.status} />}
        title={shortRunId(run.id)}
        copyValue={run.id}
        description={runTimeLabel(run)}
        onBack={onBack}
        onClose={onClose}
      />
      <PanelScroll>
        <div className="grid grid-cols-2 gap-2">
          <RunStat label="Duration" value={formatRunDuration(run)} />
          <RunStat label="Started" value={formatRunStartedDate(run)} />
          <RunStat label="Finished" value={formatDate(run.finishedAt)} />
          <RunStat label="Queued" value={formatDate(run.queuedAt)} />
        </div>

        <RunProgress status={run.status} nodes={nodes} totalSteps={totalSteps} />

        {run.error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {run.error}
          </div>
        ) : null}

        <p className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
          Select a node on the canvas to inspect its input, output, and errors for this run.
        </p>
      </PanelScroll>
    </>
  )
}

function RunStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm text-foreground">{value}</p>
    </div>
  )
}

function RunStartPanel({
  run,
  onBack,
  onClose,
}: {
  run: WorkflowRunDetail
  onBack: () => void
  onClose: () => void
}) {
  const baseUrl = client.getConfig().baseUrl ?? window.location.origin
  const fileLinkForPath = (pathSegments: readonly string[]) => ({
    inlineUrl: workflowRunFileContentUrl({ baseUrl, runId: run.id, pathSegments }),
    downloadUrl: workflowRunFileContentUrl({
      baseUrl,
      runId: run.id,
      pathSegments,
      disposition: "attachment",
    }),
  })

  return (
    <>
      <PanelHeader
        icon={<Play className={PANEL_ICON} />}
        eyebrow="Start"
        badge={
          <Badge variant="secondary" className="rounded px-1.5 py-0 font-mono text-[10px]">
            start
          </Badge>
        }
        title="Run input"
        description="Values this run was started with."
        onBack={onBack}
        onClose={onClose}
      />
      <PanelScroll>
        <PanelBlock label="Input" icon={<ArrowDownToLine className={SECTION_ICON} />}>
          <StructuredValue
            value={run.input}
            emptyLabel="No input"
            fileLinkForPath={fileLinkForPath}
          />
        </PanelBlock>
      </PanelScroll>
    </>
  )
}

function RunNodePanel({
  runNode,
  definitionNode,
  index,
  onBack,
  onClose,
}: {
  runNode: WorkflowRunNode | undefined
  definitionNode: WorkflowNode | undefined
  index: number
  onBack: () => void
  onClose: () => void
}) {
  const kind: WorkflowNodeData["kind"] = definitionNode ? definitionNode.type : "step"
  const title = runNode?.nodeKey ?? definitionNode?.key ?? "Node"
  const baseUrl = client.getConfig().baseUrl ?? window.location.origin
  const fileLinkForRoot = (root: "input" | "output") => (pathSegments: readonly string[]) => {
    if (!runNode) return null
    const input = {
      baseUrl,
      runId: runNode.workflowRunId,
      nodeKey: runNode.nodeKey,
      pathSegments,
      root,
    }
    return {
      inlineUrl: workflowNodeFileContentUrl(input),
      downloadUrl: workflowNodeFileContentUrl({ ...input, disposition: "attachment" }),
    }
  }

  return (
    <>
      <PanelHeader
        icon={<NodeKindIcon kind={kind} />}
        eyebrow={kindLabel(kind)}
        badge={
          <span className="flex items-center gap-1.5">
            {index >= 0 ? (
              <Badge
                variant="secondary"
                className="rounded px-1.5 py-0 font-mono text-[10px] tabular-nums"
              >
                #{index + 1}
              </Badge>
            ) : null}
            {runNode ? <NodeStatusBadge status={runNode.status} /> : null}
          </span>
        }
        title={title}
        onBack={onBack}
        onClose={onClose}
      />
      <PanelScroll>
        {runNode ? (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Started {formatRelativeTime(runNode.startedAt)}</span>
              <span>{formatNodeDuration(runNode)}</span>
              {runNode.finishedAt ? (
                <span>Finished {formatRelativeTime(runNode.finishedAt)}</span>
              ) : null}
            </div>

            {runNode.nodeType === "intervention" && runNode.status === "waiting" ? (
              <WorkflowInterventionPanel node={runNode} />
            ) : null}

            <PanelBlock label="Input" icon={<ArrowDownToLine className={SECTION_ICON} />}>
              <StructuredValue
                value={runNode.input}
                emptyLabel="No input"
                fileLinkForPath={fileLinkForRoot("input")}
              />
            </PanelBlock>

            {runNode.error ? (
              <PanelBlock label="Error" icon={<X className={cn(SECTION_ICON, "text-red-500")} />}>
                <p className="break-words text-sm text-destructive">{runNode.error}</p>
              </PanelBlock>
            ) : (
              <PanelBlock
                label={runNode.nodeType === "intervention" ? "Response" : "Output"}
                icon={<ArrowUpFromLine className={SECTION_ICON} />}
              >
                <StructuredValue
                  value={runNode.output ?? null}
                  emptyLabel="No output"
                  fileLinkForPath={fileLinkForRoot("output")}
                />
              </PanelBlock>
            )}
          </>
        ) : (
          <>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <p className="text-sm text-foreground">Not run yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                This node did not execute in this run. Its defined shape is shown below.
              </p>
            </div>
            {definitionNode ? <NodePanelSections node={definitionNode} /> : null}
          </>
        )}
      </PanelScroll>
    </>
  )
}
