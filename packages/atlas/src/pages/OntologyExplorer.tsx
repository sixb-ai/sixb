import type { ListObjectTypesResponse } from "@sixb/client"
import { listObjectTypesOptions } from "@sixb/client/hooks"
import { Badge, Button, CollectionViewToggle, Input, ScrollArea } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getSmoothStepPath,
  Handle,
  MarkerType,
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
import { CornerDownRight, Link2, Rows3, Search, X, Zap } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { LetterAvatar } from "../components/common"
import { humanizeIdentifier } from "../lib/labels"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"
import { ObjectTypeDetail } from "./ObjectTypeDetail"
import {
  type GraphHandleLayout,
  type GraphPoint,
  layoutOntologyGraph,
  routeOntologyGraph,
} from "./ontologyGraphLayout"

type ObjectTypeSummary = ListObjectTypesResponse[number]
type PropertySummary = ObjectTypeSummary["properties"][number]
type LinkCardinality = NonNullable<ObjectTypeSummary["links"][number]["cardinality"]>
type OntologyCollectionView = "graph" | "list"
type OntologyView = OntologyCollectionView | "details"

interface OntologyExplorerProps {
  objectTypeCounts: ReadonlyMap<string, number>
  selectedTypeId: string | null
  detailsOpen: boolean
  onSelectedTypeChange: (typeId: string | null) => void
  onOpenType: (typeId: string) => void
  onViewObjects: (typeId: string) => void
}

interface OntologyNodeData extends Record<string, unknown> {
  label: string
  objectCount: number
  propertyCount: number
  linkCount: number
  sourceHandles: GraphHandleLayout[]
  targetHandles: GraphHandleLayout[]
  searchMatch: boolean
  relationshipState: "connected" | "overview" | "selected" | "unrelated"
}

type OntologyNode = Node<OntologyNodeData, "ontology">

interface OntologyEdgeData extends Record<string, unknown> {
  relationshipLabel: string
  cardinality?: LinkCardinality
  dashed: boolean
  sections: OntologyEdgeSection[]
  labelPosition?: { x: number; y: number }
  emphasized: boolean
  contextual: boolean
  muted: boolean
  preview: boolean
}

type OntologyEdge = XYEdge<OntologyEdgeData>

interface OntologyGraphViewport {
  x: number
  y: number
  zoom: number
}

interface OntologyEdgeSection {
  startPoint: GraphPoint
  bendPoints: GraphPoint[]
  endPoint: GraphPoint
}

interface InspectorRelationship {
  typeId: string
  typeName: string
  label: string
  direction: "incoming" | "outgoing"
  cardinality?: ObjectTypeSummary["links"][number]["cardinality"]
}

const PROPERTY_PREVIEW_LIMIT = 4
const GRAPH_NODE_WIDTH = 216
const GRAPH_NODE_HEIGHT = 82
const GRAPH_LAYOUT_DURATION = 280
const ontologyCollectionViewOptions = [
  { value: "graph", label: "Graph" },
  { value: "list", label: "List" },
] as const
const ontologySelectedViewOptions = [
  ...ontologyCollectionViewOptions,
  { value: "details", label: "Details" },
] as const

export function OntologyExplorer({
  objectTypeCounts,
  selectedTypeId,
  detailsOpen,
  onSelectedTypeChange,
  onOpenType,
  onViewObjects,
}: OntologyExplorerProps) {
  const [search, setSearch] = useState("")
  const [collectionView, setCollectionView] = useState<OntologyCollectionView>(() =>
    getCollectionViewStyle("ontology", ["graph", "list"], "graph")
  )
  const [graphViewport, setGraphViewport] = useState<OntologyGraphViewport | null>(null)
  const { data: objectTypes = [] } = useQuery(listObjectTypesOptions())

  const byId = useMemo(() => {
    const map = new Map<string, ObjectTypeSummary>()
    for (const type of objectTypes) map.set(type.id, type)
    return map
  }, [objectTypes])

  const sorted = useMemo(
    () => [...objectTypes].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [objectTypes]
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sorted
    return sorted.filter((type) => matchesType(type, query))
  }, [search, sorted])

  useEffect(() => {
    if (!selectedTypeId || objectTypes.length === 0 || byId.has(selectedTypeId)) return
    onSelectedTypeChange(null)
  }, [byId, objectTypes, onSelectedTypeChange, selectedTypeId])

  useEffect(() => {
    if (!selectedTypeId || detailsOpen || collectionView !== "graph") return
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelectedTypeChange(null)
    }
    window.addEventListener("keydown", clearSelection)
    return () => window.removeEventListener("keydown", clearSelection)
  }, [collectionView, detailsOpen, onSelectedTypeChange, selectedTypeId])

  const selectedType = selectedTypeId ? (byId.get(selectedTypeId) ?? null) : null
  const view: OntologyView = detailsOpen && selectedType ? "details" : collectionView

  return (
    <div
      className={cn(
        "h-[calc(100dvh-3rem)] min-h-0 w-full bg-background md:h-dvh",
        view === "graph" && selectedType
          ? "flex flex-col overflow-y-auto min-[900px]:flex-row min-[900px]:overflow-hidden"
          : "flex flex-col overflow-y-auto lg:overflow-hidden"
      )}
    >
      <div
        className="isolate grid h-full min-h-[680px] min-w-0 flex-1 overflow-hidden lg:min-h-0"
        style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}
      >
        <header className="flex min-w-0 shrink-0 flex-col gap-3 overflow-hidden bg-background px-3 py-3 sm:px-4 lg:px-6 xl:h-16 xl:flex-row xl:items-center xl:justify-between xl:py-0">
          <div className="flex shrink-0 items-center gap-3">
            <h1 className="text-lg font-semibold text-foreground">Ontology</h1>
            <Badge variant="outline" className="text-xs">
              {objectTypes.length} {objectTypes.length === 1 ? "type" : "types"}
            </Badge>
          </div>

          <div className="flex min-w-0 w-full items-center gap-2 xl:w-auto">
            <CollectionViewToggle
              value={view}
              options={selectedType ? ontologySelectedViewOptions : ontologyCollectionViewOptions}
              onChange={(next) => {
                if (next === "details") {
                  if (selectedType) onOpenType(selectedType.id)
                  return
                }
                setCollectionView(next)
                setCollectionViewStyle("ontology", next)
                if (detailsOpen && selectedType) onSelectedTypeChange(selectedType.id)
              }}
            />
            {view !== "details" ? (
              <div className="relative min-w-0 flex-1 xl:w-64 xl:flex-none">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search types, fields, or links..."
                  className="pl-9"
                />
              </div>
            ) : null}
          </div>
        </header>

        {objectTypes.length === 0 ? (
          <EmptyOntology />
        ) : (
          <div className="relative min-h-0 overflow-hidden bg-background">
            {view === "graph" ? (
              <ReactFlowProvider>
                <OntologyGraph
                  objectTypes={objectTypes}
                  objectTypeCounts={objectTypeCounts}
                  search={search}
                  selectedTypeId={selectedTypeId}
                  onSelectType={onSelectedTypeChange}
                  savedViewport={graphViewport}
                  onViewportChange={setGraphViewport}
                />
              </ReactFlowProvider>
            ) : null}

            {view === "list" ? (
              <div className="absolute inset-0 z-10 overflow-y-auto bg-background p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 sm:p-4 lg:p-6">
                <OntologyList
                  filtered={filtered}
                  search={search}
                  byId={byId}
                  onSelectType={onOpenType}
                />
              </div>
            ) : null}

            {view === "details" && selectedType ? (
              <div className="absolute inset-0 z-10 overflow-y-auto bg-background p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 sm:p-4 lg:p-6">
                <ObjectTypeDetail
                  objectTypeId={selectedType.id}
                  embedded
                  onSelectType={onOpenType}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {view === "graph" && selectedType ? (
        <OntologyInspector
          type={selectedType}
          objectTypes={objectTypes}
          objectCount={objectTypeCounts.get(selectedType.id) ?? 0}
          onClose={() => onSelectedTypeChange(null)}
          onOpenType={onOpenType}
          onViewObjects={onViewObjects}
          onSelectType={onSelectedTypeChange}
        />
      ) : null}
    </div>
  )
}

function EmptyOntology() {
  return (
    <div className="flex min-h-72 flex-1 items-center justify-center text-sm text-muted-foreground">
      No object types defined.
    </div>
  )
}

function OntologyList({
  filtered,
  search,
  byId,
  onSelectType,
}: {
  filtered: ObjectTypeSummary[]
  search: string
  byId: ReadonlyMap<string, ObjectTypeSummary>
  onSelectType: (typeId: string) => void
}) {
  if (filtered.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No types matching "{search}".
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl overflow-hidden border border-border bg-card">
      <ul className="divide-y divide-border">
        {filtered.map((type) => (
          <li key={type.id}>
            <TypeRow
              type={type}
              parent={type.extends ? (byId.get(type.extends) ?? null) : null}
              onSelect={() => onSelectType(type.id)}
              onSelectType={onSelectType}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function OntologyGraph({
  objectTypes,
  objectTypeCounts,
  search,
  selectedTypeId,
  onSelectType,
  savedViewport,
  onViewportChange,
}: {
  objectTypes: ObjectTypeSummary[]
  objectTypeCounts: ReadonlyMap<string, number>
  search: string
  selectedTypeId: string | null
  onSelectType: (typeId: string | null) => void
  savedViewport: OntologyGraphViewport | null
  onViewportChange: (viewport: OntologyGraphViewport) => void
}) {
  const topology = useMemo(
    () => buildOntologyTopology(objectTypes, objectTypeCounts),
    [objectTypeCounts, objectTypes]
  )
  const layout = useMemo(
    () => layoutOntology(topology, selectedTypeId ?? mostConnectedNodeId(topology) ?? ""),
    [selectedTypeId, topology]
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<OntologyNode>(layout.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<OntologyEdge>(layout.edges)
  const { fitBounds, getNodes, getZoom, setCenter } = useReactFlow<OntologyNode, OntologyEdge>()
  const initialSavedViewport = useRef(savedViewport)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const layoutFrame = useRef<number | null>(null)
  const previousLayoutSelection = useRef<string | null | undefined>(undefined)
  const previousSelection = useRef<string | null | undefined>(undefined)
  nodesRef.current = nodes
  edgesRef.current = edges

  useEffect(() => {
    const target = presentOntologyLayout(layout, objectTypes, search, selectedTypeId)
    const selectionChanged =
      previousLayoutSelection.current !== undefined &&
      previousLayoutSelection.current !== selectedTypeId
    previousLayoutSelection.current = selectedTypeId
    if (layoutFrame.current !== null) window.cancelAnimationFrame(layoutFrame.current)

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!selectionChanged || reduceMotion) {
      setNodes(target.nodes)
      setEdges(target.edges)
      return
    }

    const sourceNodes = new Map(nodesRef.current.map((node) => [node.id, node]))
    const sourceEdges = new Map(edgesRef.current.map((edge) => [edge.id, edge]))
    const startedAt = window.performance.now()
    const animate = (timestamp: number) => {
      const progress = Math.min((timestamp - startedAt) / GRAPH_LAYOUT_DURATION, 1)
      const eased = easeInOutCubic(progress)
      const nextNodes = target.nodes.map((node) => {
        const source = sourceNodes.get(node.id)
        return source
          ? {
              ...node,
              position: interpolatePoint(source.position, node.position, eased),
            }
          : node
      })
      const nextEdges = target.edges.map((edge) =>
        interpolateOntologyEdge(sourceEdges.get(edge.id), edge, eased)
      )
      nodesRef.current = nextNodes
      edgesRef.current = nextEdges
      setNodes(nextNodes)
      setEdges(nextEdges)
      if (progress < 1) layoutFrame.current = window.requestAnimationFrame(animate)
      else layoutFrame.current = null
    }
    layoutFrame.current = window.requestAnimationFrame(animate)
    return () => {
      if (layoutFrame.current !== null) window.cancelAnimationFrame(layoutFrame.current)
      layoutFrame.current = null
    }
  }, [layout, objectTypes, search, selectedTypeId, setEdges, setNodes])

  useEffect(() => {
    const initialView = previousSelection.current === undefined
    previousSelection.current = selectedTypeId
    if (initialView && initialSavedViewport.current) return

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timer = window.setTimeout(() => {
      const selectedNode = selectedTypeId
        ? layout.nodes.find((node) => node.id === selectedTypeId)
        : undefined
      if (selectedNode) {
        void setCenter(
          selectedNode.position.x + GRAPH_NODE_WIDTH / 2,
          selectedNode.position.y + GRAPH_NODE_HEIGHT / 2,
          {
            zoom: Math.max(getZoom(), 0.95),
            duration: reduceMotion ? 0 : GRAPH_LAYOUT_DURATION,
          }
        )
      } else {
        void fitBounds(layout.bounds, {
          padding: 0.06,
          duration: reduceMotion ? 0 : GRAPH_LAYOUT_DURATION,
        })
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [fitBounds, getZoom, layout, selectedTypeId, setCenter])

  return (
    <div
      className="relative min-h-[520px] border-b border-border bg-background lg:min-h-0 lg:border-b-0"
      style={{ width: "100%", height: "100%" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={(_event, node) => {
          setEdges((current) =>
            current.map((edge) =>
              edge.source === node.id || edge.target === node.id
                ? {
                    ...edge,
                    data: edge.data ? { ...edge.data, preview: true } : undefined,
                  }
                : edge
            )
          )
        }}
        onNodeDragStop={(_event, node) => {
          const currentNodes = getNodes().map((current) =>
            current.id === node.id ? { ...current, position: node.position } : current
          )
          const rerouted = routeOntologyAtPositions(
            topology,
            currentNodes,
            selectedTypeId ?? mostConnectedNodeId(topology) ?? ""
          )
          const presented = presentOntologyLayout(rerouted, objectTypes, search, selectedTypeId)
          setNodes(presented.nodes)
          setEdges(presented.edges)
        }}
        onMoveEnd={(_event, viewport) => onViewportChange(viewport)}
        nodeTypes={ontologyNodeTypes}
        edgeTypes={ontologyEdgeTypes}
        onNodeClick={(_event, node) => onSelectType(node.id === selectedTypeId ? null : node.id)}
        onPaneClick={() => onSelectType(null)}
        defaultViewport={savedViewport ?? undefined}
        minZoom={0.25}
        maxZoom={1.5}
        nodesConnectable={false}
        panOnDrag
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

function layoutOntology(
  topology: {
    nodes: OntologyNode[]
    edges: OntologyEdge[]
  },
  focusId: string
): {
  nodes: OntologyNode[]
  edges: OntologyEdge[]
  bounds: { x: number; y: number; width: number; height: number }
} {
  const routed = layoutOntologyGraph(
    topology.nodes.map((node) => ({ id: node.id, label: node.data.label })),
    topology.edges.map((edge) => {
      const label = edge.data ? relationshipLabel(edge.data) : ""
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        labelWidth: Math.max(48, label.length * 6.2 + 16),
      }
    }),
    focusId,
    { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT }
  )
  return applyOntologyRouting(topology, routed)
}

function routeOntologyAtPositions(
  topology: { nodes: OntologyNode[]; edges: OntologyEdge[] },
  nodes: OntologyNode[],
  focusId: string
): ReturnType<typeof layoutOntology> {
  const positions = new Map(nodes.map((node) => [node.id, node.position]))
  const routed = routeOntologyGraph(
    topology.nodes.map((node) => ({
      id: node.id,
      label: node.data.label,
      position: positions.get(node.id) ?? node.position,
    })),
    topology.edges.map((edge) => {
      const label = edge.data ? relationshipLabel(edge.data) : ""
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        labelWidth: Math.max(48, label.length * 6.2 + 16),
      }
    }),
    focusId,
    { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT }
  )
  return applyOntologyRouting(topology, routed)
}

function applyOntologyRouting(
  topology: { nodes: OntologyNode[]; edges: OntologyEdge[] },
  routed: ReturnType<typeof layoutOntologyGraph>
): {
  nodes: OntologyNode[]
  edges: OntologyEdge[]
  bounds: { x: number; y: number; width: number; height: number }
} {
  const nodeLayout = new Map(routed.nodes.map((node) => [node.id, node]))
  const edgeLayout = new Map(routed.edges.map((edge) => [edge.id, edge]))

  return {
    nodes: topology.nodes.map((node) => {
      const positioned = nodeLayout.get(node.id)
      return {
        ...node,
        position: positioned?.position ?? node.position,
        data: {
          ...node.data,
          sourceHandles: positioned?.sourceHandles ?? [],
          targetHandles: positioned?.targetHandles ?? [],
        },
      }
    }),
    edges: topology.edges.map((edge) => {
      const routed = edgeLayout.get(edge.id)
      return {
        ...edge,
        sourceHandle: routed?.sourceHandle,
        targetHandle: routed?.targetHandle,
        data: edge.data
          ? {
              ...edge.data,
              sections: routed
                ? [
                    {
                      startPoint: routed.points[0]!,
                      bendPoints: routed.points.slice(1, -1),
                      endPoint: routed.points.at(-1)!,
                    },
                  ]
                : [],
              labelPosition: routed?.labelPosition,
              preview: false,
            }
          : undefined,
      }
    }),
    bounds: routed.bounds,
  }
}

function presentOntologyLayout(
  layout: ReturnType<typeof layoutOntology>,
  objectTypes: ObjectTypeSummary[],
  search: string,
  selectedTypeId: string | null
): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
  const query = search.trim().toLowerCase()
  const searchMatches = new Set(
    objectTypes.filter((type) => !query || matchesType(type, query)).map((type) => type.id)
  )
  const connected = new Set<string>()
  if (selectedTypeId) {
    for (const edge of layout.edges) {
      if (edge.source === selectedTypeId) connected.add(edge.target)
      if (edge.target === selectedTypeId) connected.add(edge.source)
    }
  }
  return {
    nodes: layout.nodes.map((node) => {
      const relationshipState: OntologyNodeData["relationshipState"] = !selectedTypeId
        ? "overview"
        : node.id === selectedTypeId
          ? "selected"
          : connected.has(node.id)
            ? "connected"
            : "unrelated"
      return {
        ...node,
        selected: node.id === selectedTypeId,
        data: {
          ...node.data,
          searchMatch: searchMatches.has(node.id),
          relationshipState,
        },
      }
    }),
    edges: layout.edges
      .map((edge) => presentOntologyEdge(edge, selectedTypeId, query ? searchMatches : null))
      .sort(
        (left, right) =>
          Number(left.data?.emphasized) - Number(right.data?.emphasized) ||
          left.id.localeCompare(right.id)
      ),
  }
}

function mostConnectedNodeId(topology: {
  nodes: OntologyNode[]
  edges: OntologyEdge[]
}): string | undefined {
  const degree = new Map(topology.nodes.map((node) => [node.id, 0]))
  for (const edge of topology.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  return [...topology.nodes].sort(
    (left, right) =>
      (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
      left.data.label.localeCompare(right.data.label)
  )[0]?.id
}

function buildOntologyTopology(
  objectTypes: ObjectTypeSummary[],
  objectTypeCounts: ReadonlyMap<string, number>
): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
  const typeIds = new Set(objectTypes.map((type) => type.id))

  const nodes: OntologyNode[] = objectTypes.map((type) => ({
    id: type.id,
    type: "ontology",
    position: { x: 0, y: 0 },
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
    selected: false,
    data: {
      label: displayName(type),
      objectCount: objectTypeCounts.get(type.id) ?? 0,
      propertyCount: type.properties.length,
      linkCount: type.links.length,
      sourceHandles: [],
      targetHandles: [],
      searchMatch: true,
      relationshipState: "overview",
    },
  }))

  const edges: OntologyEdge[] = []
  for (const type of objectTypes) {
    if (type.extends && typeIds.has(type.extends)) {
      edges.push(
        createOntologyEdge({
          id: `extends:${type.id}:${type.extends}`,
          source: type.id,
          target: type.extends,
          label: "extends",
          dashed: true,
        })
      )
    }
    for (const link of type.links) {
      const targets = Array.isArray(link.targetObjectTypeId)
        ? link.targetObjectTypeId
        : [link.targetObjectTypeId]
      for (const target of targets) {
        if (!typeIds.has(target)) continue
        edges.push(
          createOntologyEdge({
            id: `link:${type.id}:${link.id}:${target}`,
            source: type.id,
            target,
            label: humanizeIdentifier(link.name || link.id),
            cardinality: link.cardinality ?? "many",
          })
        )
      }
    }
  }
  return { nodes, edges }
}

function createOntologyEdge({
  id,
  source,
  target,
  label,
  cardinality,
  dashed = false,
}: {
  id: string
  source: string
  target: string
  label: string
  cardinality?: LinkCardinality
  dashed?: boolean
}): OntologyEdge {
  return {
    id,
    source,
    target,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: "var(--border)",
    },
    type: "ontology",
    style: {
      stroke: "var(--border)",
      strokeWidth: 1,
      strokeDasharray: dashed ? "5 4" : undefined,
      opacity: 0.8,
    },
    data: {
      relationshipLabel: label,
      cardinality,
      dashed,
      sections: [],
      emphasized: false,
      contextual: false,
      muted: false,
      preview: false,
    },
  }
}

function relationshipLabel(data: OntologyEdgeData): string {
  if (!data.cardinality) return data.relationshipLabel
  const cardinality = data.cardinality === "one" ? "1" : "many"
  return `${data.relationshipLabel} · ${cardinality}`
}

function presentOntologyEdge(
  edge: OntologyEdge,
  selectedTypeId: string | null,
  searchMatches: ReadonlySet<string> | null
): OntologyEdge {
  const active = selectedTypeId === edge.source || selectedTypeId === edge.target
  const matchesSearch =
    !searchMatches || searchMatches.has(edge.source) || searchMatches.has(edge.target)
  const emphasized = active && matchesSearch
  const contextual = Boolean(selectedTypeId && !active && matchesSearch)

  return {
    ...edge,
    label: edge.data ? relationshipLabel(edge.data) : undefined,
    data: edge.data ? { ...edge.data, emphasized, contextual, muted: !matchesSearch } : undefined,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: emphasized ? "var(--foreground)" : "var(--muted-foreground)",
    },
    style: {
      ...edge.style,
      stroke: emphasized ? "var(--foreground)" : "var(--muted-foreground)",
      strokeWidth: emphasized ? 1.5 : 1.1,
      opacity: !matchesSearch ? 0.08 : contextual ? 0.3 : 0.78,
      transition: "opacity 180ms ease, stroke 180ms ease, stroke-width 180ms ease",
    },
  }
}

function OntologyRelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  data,
}: EdgeProps<OntologyEdge>) {
  const [previewPath, previewLabelX, previewLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: 18,
  })
  const path = data?.preview
    ? previewPath
    : data?.sections.length
      ? data.sections.map((section) => roundedOrthogonalPath(section)).join(" ")
      : `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
  const labelX = data?.preview ? previewLabelX : (data?.labelPosition?.x ?? (sourceX + targetX) / 2)
  const labelY = data?.preview ? previewLabelY : (data?.labelPosition?.y ?? (sourceY + targetY) / 2)

  return (
    <>
      {data?.emphasized ? (
        <BaseEdge
          id={`${id}-casing`}
          path={path}
          style={{
            stroke: "var(--background)",
            strokeWidth: 6,
            strokeDasharray: undefined,
            opacity: 0.96,
          }}
          interactionWidth={0}
        />
      ) : null}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={16} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "pointer-events-none absolute whitespace-nowrap rounded-md border bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-700 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-opacity",
              data?.emphasized ? "border-neutral-400" : "border-neutral-200",
              data?.contextual && "opacity-35",
              data?.muted && "opacity-10"
            )}
            style={{
              zIndex: 20,
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

function interpolateOntologyEdge(
  source: OntologyEdge | undefined,
  target: OntologyEdge,
  progress: number
): OntologyEdge {
  const sourceSection = source?.data?.sections[0]
  const targetSection = target.data?.sections[0]
  if (!sourceSection || !targetSection || !target.data) return target

  const sourcePoints = [
    sourceSection.startPoint,
    ...sourceSection.bendPoints,
    sourceSection.endPoint,
  ]
  const targetPoints = [
    targetSection.startPoint,
    ...targetSection.bendPoints,
    targetSection.endPoint,
  ]
  const pointCount = Math.max(sourcePoints.length, targetPoints.length)
  const from = resamplePolyline(sourcePoints, pointCount)
  const to = resamplePolyline(targetPoints, pointCount)
  const points = from.map((point, index) => interpolatePoint(point, to[index]!, progress))
  const sourceLabel = source?.data?.labelPosition ?? target.data.labelPosition
  const targetLabel = target.data.labelPosition

  return {
    ...target,
    data: {
      ...target.data,
      sections: [
        {
          startPoint: points[0]!,
          bendPoints: points.slice(1, -1),
          endPoint: points.at(-1)!,
        },
      ],
      labelPosition:
        sourceLabel && targetLabel
          ? interpolatePoint(sourceLabel, targetLabel, progress)
          : targetLabel,
    },
  }
}

function resamplePolyline(points: GraphPoint[], count: number): GraphPoint[] {
  if (points.length === count) return points
  const lengths = points
    .slice(1)
    .map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total === 0) return Array.from({ length: count }, () => points[0]!)

  return Array.from({ length: count }, (_, index) => {
    const distance = (total * index) / (count - 1)
    let traversed = 0
    for (let segment = 0; segment < lengths.length; segment += 1) {
      const length = lengths[segment]!
      if (traversed + length < distance) {
        traversed += length
        continue
      }
      const progress = length === 0 ? 0 : (distance - traversed) / length
      return interpolatePoint(points[segment]!, points[segment + 1]!, progress)
    }
    return points.at(-1)!
  })
}

function interpolatePoint(from: GraphPoint, to: GraphPoint, progress: number): GraphPoint {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  }
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2
}

function roundedOrthogonalPath(section: OntologyEdgeSection): string {
  const points = [section.startPoint, ...section.bendPoints, section.endPoint]
  if (points.length < 3) {
    return `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 0} L ${points[1]?.x ?? 0} ${points[1]?.y ?? 0}`
  }

  let path = `M ${points[0]!.x} ${points[0]!.y}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!
    const corner = points[index]!
    const next = points[index + 1]!
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(8, incoming / 2, outgoing / 2)
    const before = moveToward(corner, previous, radius)
    const after = moveToward(corner, next, radius)
    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`
  }
  const end = points.at(-1)!
  return `${path} L ${end.x} ${end.y}`
}

function moveToward(from: GraphPoint, to: GraphPoint, distance: number): GraphPoint {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return {
    x: from.x + ((to.x - from.x) / length) * distance,
    y: from.y + ((to.y - from.y) / length) * distance,
  }
}

const ontologyEdgeTypes = { ontology: OntologyRelationshipEdge } as unknown as EdgeTypes

function OntologyGraphCard({ data, selected }: NodeProps<OntologyNode>) {
  return (
    <div
      className={cn(
        "flex h-[82px] w-[216px] cursor-pointer flex-col justify-center rounded-xl bg-card px-3.5 shadow-sm transition-[transform,border-color,box-shadow,opacity] duration-200 hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md",
        selected ? "border-2 border-foreground shadow-md" : "border border-border",
        data.relationshipState === "unrelated" && "opacity-55 hover:opacity-85",
        !data.searchMatch && "opacity-20 hover:opacity-55"
      )}
    >
      <OntologyHandles handles={data.targetHandles} type="target" />
      <OntologyHandles handles={data.sourceHandles} type="source" />
      <div className="flex min-w-0 items-start gap-2.5">
        <LetterAvatar label={data.label} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-foreground">{data.label}</p>
          <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
            {countLabel(data.objectCount, "object")}
          </p>
          <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
            {countLabel(data.propertyCount, "property", "properties")}
            <span aria-hidden="true" className="px-1.5 text-border">
              ·
            </span>
            {countLabel(data.linkCount, "link")}
          </p>
        </div>
      </div>
    </div>
  )
}

function OntologyHandles({
  handles,
  type,
}: {
  handles: GraphHandleLayout[]
  type: "source" | "target"
}) {
  return handles.map((handle) => {
    const position =
      handle.side === "top"
        ? Position.Top
        : handle.side === "bottom"
          ? Position.Bottom
          : handle.side === "right"
            ? Position.Right
            : Position.Left
    const vertical = handle.side === "left" || handle.side === "right"
    return (
      <Handle
        key={handle.id}
        type={type}
        position={position}
        id={handle.id}
        style={vertical ? { top: `${handle.offset}%` } : { left: `${handle.offset}%` }}
        className="!size-2 !border-0 !bg-transparent !opacity-0"
      />
    )
  })
}

const ontologyNodeTypes = { ontology: OntologyGraphCard } as unknown as NodeTypes

function OntologyInspector({
  type,
  objectTypes,
  objectCount,
  onClose,
  onOpenType,
  onViewObjects,
  onSelectType,
}: {
  type: ObjectTypeSummary
  objectTypes: ObjectTypeSummary[]
  objectCount: number
  onClose: () => void
  onOpenType: (typeId: string) => void
  onViewObjects: (typeId: string) => void
  onSelectType: (typeId: string | null) => void
}) {
  const byId = new Map(objectTypes.map((candidate) => [candidate.id, candidate]))
  const outgoing: InspectorRelationship[] = type.links.flatMap((link) => {
    const targets = Array.isArray(link.targetObjectTypeId)
      ? link.targetObjectTypeId
      : [link.targetObjectTypeId]
    return targets.map((target) => ({
      typeId: target,
      typeName: byId.has(target) ? displayName(byId.get(target)!) : humanizeIdentifier(target),
      label: humanizeIdentifier(link.name || link.id),
      direction: "outgoing" as const,
      cardinality: link.cardinality,
    }))
  })
  const incoming: InspectorRelationship[] = objectTypes.flatMap((candidate) =>
    candidate.links.flatMap((link) => {
      const targets = Array.isArray(link.targetObjectTypeId)
        ? link.targetObjectTypeId
        : [link.targetObjectTypeId]
      return targets.includes(type.id)
        ? [
            {
              typeId: candidate.id,
              typeName: displayName(candidate),
              label: humanizeIdentifier(link.name || link.id),
              direction: "incoming" as const,
              cardinality: link.cardinality,
            },
          ]
        : []
    })
  )
  const inheritance: InspectorRelationship[] = []
  if (type.extends) {
    const parent = byId.get(type.extends)
    inheritance.push({
      typeId: type.extends,
      typeName: parent ? displayName(parent) : humanizeIdentifier(type.extends),
      label: "Extends",
      direction: "outgoing",
    })
  }
  for (const subtype of objectTypes.filter((candidate) => candidate.extends === type.id)) {
    inheritance.push({
      typeId: subtype.id,
      typeName: displayName(subtype),
      label: "Extended by",
      direction: "incoming",
    })
  }
  return (
    <aside className="relative z-20 flex h-full min-h-0 w-full flex-col overflow-hidden border-t border-sidebar-border bg-white dark:bg-sidebar min-[900px]:w-[360px] min-[900px]:shrink-0 min-[900px]:border-l min-[900px]:border-t-0">
      <ScrollArea className="min-h-0 flex-1 bg-white dark:bg-sidebar">
        <div className="p-4 lg:p-5">
          <div className="border-b border-border pb-5">
            <div className="flex items-start gap-3">
              <h2 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-foreground">
                {displayName(type)}
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close object type details"
                className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
              >
                <X />
              </Button>
            </div>
            {type.description ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{type.description}</p>
            ) : null}
          </div>

          <div className="space-y-6 pt-6">
            <InspectorSection title="Properties" count={type.properties.length}>
              {type.properties.length > 0 ? (
                <div className="divide-y divide-border/60">
                  {type.properties.map((property) => (
                    <div
                      key={property.id}
                      title={property.description ?? undefined}
                      className="flex min-w-0 items-center gap-2 py-2.5 first:pt-0"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="flex min-w-0 items-center">
                          <code className="min-w-0 truncate font-mono text-[11px] font-medium text-foreground">
                            {property.id}
                          </code>
                          {property.required ? (
                            <span
                              aria-label="Required"
                              title="Required"
                              className="ml-0.5 shrink-0 text-xs font-semibold leading-none text-destructive"
                            >
                              *
                            </span>
                          ) : null}
                        </span>
                        {property.primary ? (
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1 py-0 text-[8px] font-semibold"
                          >
                            ID
                          </Badge>
                        ) : null}
                        {property.mode === "telemetry" ? (
                          <Badge
                            variant="secondary"
                            className="h-4 shrink-0 rounded px-1 py-0 text-[8px]"
                          >
                            Telemetry
                          </Badge>
                        ) : null}
                        {property.nullable ? (
                          <span className="shrink-0 text-[9px] text-muted-foreground">
                            Nullable
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {schemaTypeLabel(property)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">No properties</p>
              )}
            </InspectorSection>

            <InspectorSection title="Connected to" count={outgoing.length}>
              <RelationshipList
                items={outgoing}
                emptyLabel="No outgoing links"
                onSelect={onSelectType}
              />
            </InspectorSection>

            <InspectorSection title="Linked from" count={incoming.length}>
              <RelationshipList
                items={incoming}
                emptyLabel="No incoming links"
                onSelect={onSelectType}
              />
            </InspectorSection>

            {inheritance.length > 0 ? (
              <InspectorSection title="Inheritance" count={inheritance.length}>
                <RelationshipList items={inheritance} onSelect={onSelectType} />
              </InspectorSection>
            ) : null}

            <InspectorSection title="Actions" count={type.actions.length}>
              {type.actions.length > 0 ? (
                <div className="divide-y divide-border/60">
                  {type.actions.map((action) => (
                    <div key={action.id} className="py-2 text-xs first:pt-0">
                      {humanizeIdentifier(action.name || action.id)}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">No actions</p>
              )}
            </InspectorSection>
          </div>
        </div>
      </ScrollArea>

      <div className="shrink-0 space-y-2 border-t border-sidebar-border bg-white p-4 dark:bg-sidebar lg:p-5">
        <Button className="w-full" size="sm" onClick={() => onViewObjects(type.id)}>
          View {countLabel(objectCount, "object")}
        </Button>
        <Button
          variant="outline"
          className="w-full bg-white dark:bg-sidebar"
          size="sm"
          onClick={() => onOpenType(type.id)}
        >
          Open details
        </Button>
      </div>
    </aside>
  )
}

function InspectorSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  )
}

function RelationshipList({
  items,
  emptyLabel = "No relationships",
  onSelect,
}: {
  items: InspectorRelationship[]
  emptyLabel?: string
  onSelect: (typeId: string) => void
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground/70">{emptyLabel}</p>
  }
  return (
    <div className="divide-y divide-border/60">
      {items.map((item, index) => (
        <button
          key={`${item.direction}:${item.typeId}:${item.label}:${index}`}
          type="button"
          onClick={() => onSelect(item.typeId)}
          className="group -mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-2.5 text-left transition-colors first:pt-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium leading-4 text-foreground">
              {item.label}
            </span>
            {item.cardinality ? (
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                {item.cardinality}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
            {item.typeName}
          </span>
        </button>
      ))}
    </div>
  )
}

interface TypeRowProps {
  type: ObjectTypeSummary
  parent: ObjectTypeSummary | null
  onSelect: () => void
  onSelectType: (typeId: string) => void
}

function TypeRow({ type, parent, onSelect, onSelectType }: TypeRowProps) {
  const preview = previewProperties(type.properties, PROPERTY_PREVIEW_LIMIT)
  const remaining = type.properties.length - preview.length
  const name = displayName(type)
  const showId = !isRedundantId(name, type.id)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className="group flex cursor-pointer items-start gap-4 px-4 py-3.5 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <div className="pt-0.5">
        <LetterAvatar label={name} size="sm" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{name}</span>
          {showId ? (
            <code className="font-mono text-[11px] text-muted-foreground">{type.id}</code>
          ) : null}
          {parent ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onSelectType(parent.id)
              }}
              className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CornerDownRight className="size-2.5" />
              extends {displayName(parent)}
            </button>
          ) : null}
        </div>
        {type.description ? (
          <p className="line-clamp-1 text-xs leading-5 text-foreground/75">{type.description}</p>
        ) : null}
        {preview.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px]">
            {preview.map((property, index) => (
              <span key={property.id} className="flex items-center gap-1.5">
                <span
                  className={cn(property.primary ? "text-foreground" : "text-muted-foreground")}
                >
                  {property.id}
                </span>
                {index < preview.length - 1 ? (
                  <span aria-hidden="true" className="text-border">
                    ·
                  </span>
                ) : null}
              </span>
            ))}
            {remaining > 0 ? (
              <span className="ml-0.5 text-muted-foreground/70">+{remaining}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="hidden shrink-0 items-center gap-4 pt-1 text-[11px] tabular-nums text-muted-foreground sm:flex">
        <Metric
          icon={<Rows3 className="size-3.5" />}
          value={type.properties.length}
          label="properties"
        />
        {type.links.length > 0 ? (
          <Metric icon={<Link2 className="size-3.5" />} value={type.links.length} label="links" />
        ) : null}
        {type.actions.length > 0 ? (
          <Metric icon={<Zap className="size-3.5" />} value={type.actions.length} label="actions" />
        ) : null}
      </div>
    </div>
  )
}

function Metric({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5" title={`${value} ${label}`}>
      <span className="text-muted-foreground/70">{icon}</span>
      <span>{value}</span>
    </span>
  )
}

function previewProperties(properties: PropertySummary[], limit: number): PropertySummary[] {
  const primary = properties.find((property) => property.primary)
  const rest = properties.filter((property) => property.id !== primary?.id)
  return (primary ? [primary, ...rest] : rest).slice(0, limit)
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`
}

function schemaTypeLabel(property: PropertySummary): string {
  return schemaValueLabel(property.schema, property.semanticType)
}

function schemaValueLabel(schema: unknown, fallback = "unknown"): string {
  if (typeof schema === "string") return schema
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return fallback
  }
  const schemaRecord = schema as Record<string, unknown>
  if (schemaRecord.type === "valueTypeRef" && typeof schemaRecord.valueTypeId === "string") {
    return schemaRecord.valueTypeId
  }
  if (typeof schemaRecord.type === "string") return schemaRecord.type
  return fallback
}

function displayName(type: ObjectTypeSummary): string {
  return humanizeIdentifier(type.name || type.id)
}

function isRedundantId(name: string, id: string): boolean {
  return normalize(name) === normalize(id)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_.-]+/g, "")
}

function matchesType(type: ObjectTypeSummary, query: string): boolean {
  if (
    type.id.toLowerCase().includes(query) ||
    type.name.toLowerCase().includes(query) ||
    (type.description?.toLowerCase().includes(query) ?? false)
  ) {
    return true
  }
  return (
    type.properties.some(
      (property) =>
        property.id.toLowerCase().includes(query) || property.name.toLowerCase().includes(query)
    ) ||
    type.links.some((link) =>
      [
        link.id,
        link.name,
        ...(Array.isArray(link.targetObjectTypeId) ? link.targetObjectTypeId : []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    ) ||
    type.actions.some(
      (action) =>
        action.id.toLowerCase().includes(query) || action.name.toLowerCase().includes(query)
    )
  )
}
