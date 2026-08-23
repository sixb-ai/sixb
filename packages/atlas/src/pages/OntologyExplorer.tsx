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
  sourcePorts: OntologyPort[]
  targetPorts: OntologyPort[]
  searchMatch: boolean
  relationshipState: "overview" | "selected" | "connected" | "unrelated"
}

type OntologyNode = Node<OntologyNodeData, "ontology">

interface OntologyEdgeData extends Record<string, unknown> {
  relationshipLabel: string
  cardinality?: LinkCardinality
  dashed: boolean
  stepPosition?: number
}

type OntologyEdge = XYEdge<OntologyEdgeData>

interface OntologyGraphViewport {
  x: number
  y: number
  zoom: number
}

type OntologyNodePositions = Record<string, { x: number; y: number }>

interface OntologyPort {
  id: string
  side: "bottom" | "left" | "right" | "top"
  offset: number
}

interface InspectorRelationship {
  typeId: string
  typeName: string
  label: string
  direction: "incoming" | "outgoing"
  cardinality?: ObjectTypeSummary["links"][number]["cardinality"]
}

const PROPERTY_PREVIEW_LIMIT = 4
const GRAPH_COLUMN_SPACING = 400
const GRAPH_ROW_SPACING = 144
const GRAPH_LAYOUT_DURATION = 280
const GRAPH_PORT_MIN_OFFSET = 22
const GRAPH_PORT_MAX_OFFSET = 78
const GRAPH_EDGE_LANE_MIN = 0.28
const GRAPH_EDGE_LANE_MAX = 0.72
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
  const [graphNodePositions, setGraphNodePositions] = useState<OntologyNodePositions>({})
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
                  savedNodePositions={graphNodePositions}
                  onViewportChange={setGraphViewport}
                  onNodePositionChange={(nodeId, position) => {
                    setGraphNodePositions((current) => ({ ...current, [nodeId]: position }))
                  }}
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
  savedNodePositions,
  onViewportChange,
  onNodePositionChange,
}: {
  objectTypes: ObjectTypeSummary[]
  objectTypeCounts: ReadonlyMap<string, number>
  search: string
  selectedTypeId: string | null
  onSelectType: (typeId: string | null) => void
  savedViewport: OntologyGraphViewport | null
  savedNodePositions: OntologyNodePositions
  onViewportChange: (viewport: OntologyGraphViewport) => void
  onNodePositionChange: (nodeId: string, position: { x: number; y: number }) => void
}) {
  const topology = useMemo(
    () => buildOntologyTopology(objectTypes, objectTypeCounts),
    [objectTypeCounts, objectTypes]
  )
  const initialGraph = useMemo(() => {
    const positions = resolveOntologyPositions(topology, selectedTypeId, savedNodePositions)
    const nodes = topology.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }))
    const edges = topology.edges.map((edge) => orientOntologyEdge(edge, positions))
    return assignOntologyPorts(nodes, edges, positions, selectedTypeId)
  }, [savedNodePositions, selectedTypeId, topology])
  const [nodes, setNodes, onNodesChange] = useNodesState<OntologyNode>(initialGraph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<OntologyEdge>(initialGraph.edges)
  const { fitView, getNodes } = useReactFlow()
  const nodesRef = useRef(nodes)
  const layoutFrame = useRef<number | null>(null)
  const previousLayoutSelection = useRef<string | null>(selectedTypeId)
  const previousFitSelection = useRef<string | null>(selectedTypeId)

  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  useEffect(() => {
    if (previousFitSelection.current === selectedTypeId) return
    previousFitSelection.current = selectedTypeId
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timer = window.setTimeout(
      () => {
        void fitView({
          nodes: getNodes(),
          padding: 0.14,
          maxZoom: 1.1,
          duration: reduceMotion ? 0 : 240,
        })
      },
      reduceMotion ? 0 : GRAPH_LAYOUT_DURATION + 40
    )
    return () => window.clearTimeout(timer)
  }, [fitView, getNodes, selectedTypeId])

  useEffect(() => {
    const query = search.trim().toLowerCase()
    const relatedTypeIds = selectedTypeId
      ? collectRelatedTypeIds(topology.edges, selectedTypeId)
      : new Set<string>()
    const searchMatches = new Set(
      objectTypes.filter((type) => !query || matchesType(type, query)).map((type) => type.id)
    )
    const targetPositions = resolveOntologyPositions(topology, selectedTypeId, savedNodePositions)
    const targetNodesWithoutPorts: OntologyNode[] = topology.nodes.map((node) => {
      const relationshipState: OntologyNodeData["relationshipState"] = !selectedTypeId
        ? "overview"
        : node.id === selectedTypeId
          ? "selected"
          : relatedTypeIds.has(node.id)
            ? "connected"
            : "unrelated"

      return {
        ...node,
        position: targetPositions.get(node.id) ?? node.position,
        draggable: selectedTypeId === null,
        selected: relationshipState === "selected",
        data: {
          ...node.data,
          searchMatch: searchMatches.has(node.id),
          relationshipState,
        },
      }
    })
    const orientedEdges = topology.edges.map((edge) => orientOntologyEdge(edge, targetPositions))
    const { nodes: targetNodes, edges: portedEdges } = assignOntologyPorts(
      targetNodesWithoutPorts,
      orientedEdges,
      targetPositions,
      selectedTypeId
    )
    setEdges(
      portedEdges.map((edge) =>
        presentOntologyEdge(edge, selectedTypeId, query ? searchMatches : null)
      )
    )

    const selectionChanged = previousLayoutSelection.current !== selectedTypeId
    previousLayoutSelection.current = selectedTypeId
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!selectionChanged || reduceMotion) {
      nodesRef.current = targetNodes
      setNodes(targetNodes)
      return
    }

    if (layoutFrame.current !== null) window.cancelAnimationFrame(layoutFrame.current)
    const currentById = new Map(nodesRef.current.map((node) => [node.id, node]))
    const startPositions = new Map(
      targetNodes.map((node) => [node.id, currentById.get(node.id)?.position ?? node.position])
    )
    const startedAt = window.performance.now()

    const animateLayout = (timestamp: number) => {
      const progress = Math.min((timestamp - startedAt) / GRAPH_LAYOUT_DURATION, 1)
      const eased = easeInOutCubic(progress)
      const nextNodes = targetNodes.map((node) => {
        const start = startPositions.get(node.id) ?? node.position
        return {
          ...node,
          position: {
            x: start.x + (node.position.x - start.x) * eased,
            y: start.y + (node.position.y - start.y) * eased,
          },
        }
      })
      nodesRef.current = nextNodes
      setNodes(nextNodes)
      if (progress < 1) layoutFrame.current = window.requestAnimationFrame(animateLayout)
      else layoutFrame.current = null
    }

    layoutFrame.current = window.requestAnimationFrame(animateLayout)
    return () => {
      if (layoutFrame.current !== null) window.cancelAnimationFrame(layoutFrame.current)
      layoutFrame.current = null
    }
  }, [objectTypes, savedNodePositions, search, selectedTypeId, setEdges, setNodes, topology])

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
        onInit={(instance) => {
          if (savedViewport !== null || selectedTypeId === null) return
          window.setTimeout(() => {
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            void instance.fitView({
              nodes: instance.getNodes(),
              padding: 0.14,
              maxZoom: 1.1,
              duration: reduceMotion ? 0 : 240,
            })
          }, 120)
        }}
        onNodeDragStop={(_event, node) => onNodePositionChange(node.id, node.position)}
        onMoveEnd={(_event, viewport) => onViewportChange(viewport)}
        nodeTypes={ontologyNodeTypes}
        edgeTypes={ontologyEdgeTypes}
        onNodeClick={(_event, node) => onSelectType(node.id === selectedTypeId ? null : node.id)}
        onPaneClick={() => onSelectType(null)}
        defaultViewport={savedViewport ?? undefined}
        fitView={savedViewport === null && selectedTypeId === null}
        fitViewOptions={{ padding: 0.1, maxZoom: 1.1 }}
        minZoom={0.25}
        maxZoom={1.5}
        nodesConnectable={false}
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

function buildOntologyTopology(
  objectTypes: ObjectTypeSummary[],
  objectTypeCounts: ReadonlyMap<string, number>
): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
  const typeIds = new Set(objectTypes.map((type) => type.id))
  const anchorType = mostConnectedType(objectTypes)
  const anchorTypeId = anchorType?.id ?? objectTypes[0]?.id
  const leftIds = new Set(
    anchorType?.links.flatMap((link) =>
      Array.isArray(link.targetObjectTypeId) ? link.targetObjectTypeId : [link.targetObjectTypeId]
    ) ?? []
  )
  leftIds.delete(anchorTypeId ?? "")
  const byName = (left: ObjectTypeSummary, right: ObjectTypeSummary) =>
    displayName(left).localeCompare(displayName(right))
  const leftTypes = objectTypes.filter((type) => leftIds.has(type.id)).sort(byName)
  let rightTypes = objectTypes
    .filter((type) => type.id !== anchorTypeId && !leftIds.has(type.id))
    .sort(byName)
  if (leftTypes.length === 0) {
    const split = Math.floor(rightTypes.length / 2)
    for (const type of rightTypes.slice(0, split)) leftIds.add(type.id)
    rightTypes = rightTypes.slice(split)
  }
  const resolvedLeftTypes = objectTypes.filter((type) => leftIds.has(type.id)).sort(byName)
  const rowCount = Math.max(resolvedLeftTypes.length, rightTypes.length, 1)
  const centerY = ((rowCount - 1) * GRAPH_ROW_SPACING) / 2
  const positions = new Map<string, { x: number; y: number }>()
  if (anchorTypeId) positions.set(anchorTypeId, { x: 0, y: centerY })
  resolvedLeftTypes.forEach((type, index) => {
    positions.set(type.id, { x: -GRAPH_COLUMN_SPACING, y: index * GRAPH_ROW_SPACING })
  })
  rightTypes.forEach((type, index) => {
    positions.set(type.id, { x: GRAPH_COLUMN_SPACING, y: index * GRAPH_ROW_SPACING })
  })

  const nodes: OntologyNode[] = objectTypes.map((type) => ({
    id: type.id,
    type: "ontology",
    position: positions.get(type.id) ?? { x: 0, y: 0 },
    width: 216,
    height: 82,
    draggable: true,
    selected: false,
    data: {
      label: displayName(type),
      objectCount: objectTypeCounts.get(type.id) ?? 0,
      propertyCount: type.properties.length,
      linkCount: type.links.length,
      sourcePorts: [],
      targetPorts: [],
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
          positions,
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
            positions,
          })
        )
      }
    }
  }
  return { nodes, edges }
}

function resolveOntologyPositions(
  topology: { nodes: OntologyNode[]; edges: OntologyEdge[] },
  selectedTypeId: string | null,
  savedNodePositions: OntologyNodePositions
): Map<string, { x: number; y: number }> {
  const overview = new Map(
    topology.nodes.map((node) => [node.id, savedNodePositions[node.id] ?? node.position])
  )
  if (!selectedTypeId) return overview

  const outgoing = new Set<string>()
  const incoming = new Set<string>()
  for (const edge of topology.edges) {
    if (edge.source === selectedTypeId && edge.target !== selectedTypeId) outgoing.add(edge.target)
    if (edge.target === selectedTypeId && edge.source !== selectedTypeId) incoming.add(edge.source)
  }
  for (const typeId of outgoing) incoming.delete(typeId)

  const labels = new Map(topology.nodes.map((node) => [node.id, node.data.label]))
  const byLabel = (left: string, right: string) =>
    (labels.get(left) ?? left).localeCompare(labels.get(right) ?? right)
  const incomingIds = [...incoming].sort(byLabel)
  const outgoingIds = [...outgoing].sort(byLabel)
  const unrelatedIds = topology.nodes
    .map((node) => node.id)
    .filter((typeId) => typeId !== selectedTypeId && !incoming.has(typeId) && !outgoing.has(typeId))
    .sort(byLabel)
  const leftUnrelated: string[] = []
  const rightUnrelated: string[] = []
  for (const typeId of unrelatedIds) {
    const leftCount = incomingIds.length + leftUnrelated.length
    const rightCount = outgoingIds.length + rightUnrelated.length
    if (leftCount < rightCount) {
      leftUnrelated.push(typeId)
    } else if (rightCount < leftCount) {
      rightUnrelated.push(typeId)
    } else if ((overview.get(typeId)?.x ?? 0) < 0) {
      leftUnrelated.push(typeId)
    } else {
      rightUnrelated.push(typeId)
    }
  }

  const rowCount = Math.max(
    incomingIds.length + leftUnrelated.length,
    outgoingIds.length + rightUnrelated.length,
    1
  )
  const centerY = ((rowCount - 1) * GRAPH_ROW_SPACING) / 2
  const focused = new Map(overview)
  focused.set(selectedTypeId, { x: 0, y: centerY })

  const placeColumn = (directIds: string[], mutedIds: string[], x: number) => {
    const directStart = Math.floor((rowCount - directIds.length) / 2)
    const occupied = new Set<number>()
    directIds.forEach((typeId, index) => {
      const row = directStart + index
      occupied.add(row)
      focused.set(typeId, { x, y: row * GRAPH_ROW_SPACING })
    })
    const availableRows = Array.from({ length: rowCount }, (_, index) => index).filter(
      (index) => !occupied.has(index)
    )
    mutedIds.forEach((typeId, index) => {
      focused.set(typeId, { x, y: (availableRows[index] ?? index) * GRAPH_ROW_SPACING })
    })
  }

  placeColumn(incomingIds, leftUnrelated, -GRAPH_COLUMN_SPACING)
  placeColumn(outgoingIds, rightUnrelated, GRAPH_COLUMN_SPACING)
  return focused
}

function orientOntologyEdge(
  edge: OntologyEdge,
  positions: ReadonlyMap<string, { x: number; y: number }>
): OntologyEdge {
  const sourceOnLeft = (positions.get(edge.target)?.x ?? 0) < (positions.get(edge.source)?.x ?? 0)
  return {
    ...edge,
    sourceHandle: sourceOnLeft ? "source-left" : "source-right",
    targetHandle: sourceOnLeft ? "target-right" : "target-left",
  }
}

function assignOntologyPorts(
  nodes: OntologyNode[],
  edges: OntologyEdge[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  selectedTypeId: string | null
): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
  const edgeGroups = new Map<string, OntologyEdge[]>()
  for (const edge of edges) {
    const side = edge.targetHandle === "target-right" ? "right" : "left"
    const key = `${edge.target}:${side}`
    const group = edgeGroups.get(key) ?? []
    group.push(edge)
    edgeGroups.set(key, group)
  }

  const targetPortsByNode = new Map<string, OntologyPort[]>()
  const targetPortedEdges = new Map<string, OntologyEdge>()
  for (const group of edgeGroups.values()) {
    group.sort((left, right) => {
      const verticalDifference =
        (positions.get(left.source)?.y ?? 0) - (positions.get(right.source)?.y ?? 0)
      return verticalDifference || left.id.localeCompare(right.id)
    })
    const baseSide: OntologyPort["side"] =
      group[0]?.targetHandle === "target-right" ? "right" : "left"
    const perimeterCount =
      group[0]?.target === selectedTypeId && group.length >= 3
        ? Math.floor((group.length + 1) / 3)
        : 0
    const edgesBySide = new Map<OntologyPort["side"], OntologyEdge[]>()
    group.forEach((edge, index) => {
      const side: OntologyPort["side"] =
        index < perimeterCount
          ? "top"
          : index >= group.length - perimeterCount
            ? "bottom"
            : baseSide
      const sideEdges = edgesBySide.get(side) ?? []
      sideEdges.push(edge)
      edgesBySide.set(side, sideEdges)
    })

    for (const [side, sideEdges] of edgesBySide) {
      sideEdges.forEach((edge, index) => {
        const offset = ontologyPortOffset(side, baseSide, index, sideEdges.length)
        const id = `target-${side}-${baseSide}-${index}`
        const ports = targetPortsByNode.get(edge.target) ?? []
        ports.push({ id, side, offset })
        targetPortsByNode.set(edge.target, ports)

        const stepPosition =
          sideEdges.length === 1
            ? 0.5
            : GRAPH_EDGE_LANE_MIN +
              ((GRAPH_EDGE_LANE_MAX - GRAPH_EDGE_LANE_MIN) * index) / (sideEdges.length - 1)
        targetPortedEdges.set(edge.id, {
          ...edge,
          targetHandle: id,
          data: edge.data ? { ...edge.data, stepPosition } : undefined,
        })
      })
    }
  }

  const edgesWithTargetPorts = edges.map((edge) => targetPortedEdges.get(edge.id) ?? edge)
  const sourcePortsByNode = new Map<string, OntologyPort[]>()
  const sourcePortedEdges = new Map<string, OntologyEdge>()
  const selectedOutgoingEdges = selectedTypeId
    ? edgesWithTargetPorts
        .filter((edge) => edge.source === selectedTypeId && edge.target !== selectedTypeId)
        .sort((left, right) => {
          const verticalDifference =
            (positions.get(left.target)?.y ?? 0) - (positions.get(right.target)?.y ?? 0)
          return verticalDifference || left.id.localeCompare(right.id)
        })
    : []

  if (selectedTypeId && selectedOutgoingEdges.length > 1) {
    const baseSide: OntologyPort["side"] =
      selectedOutgoingEdges[0]?.sourceHandle === "source-left" ? "left" : "right"
    const perimeterCount =
      selectedOutgoingEdges.length >= 3 ? Math.floor((selectedOutgoingEdges.length + 1) / 3) : 0
    const edgesBySide = new Map<OntologyPort["side"], OntologyEdge[]>()
    selectedOutgoingEdges.forEach((edge, index) => {
      const side: OntologyPort["side"] =
        index < perimeterCount
          ? "top"
          : index >= selectedOutgoingEdges.length - perimeterCount
            ? "bottom"
            : baseSide
      const sideEdges = edgesBySide.get(side) ?? []
      sideEdges.push(edge)
      edgesBySide.set(side, sideEdges)
    })

    for (const [side, sideEdges] of edgesBySide) {
      sideEdges.forEach((edge, index) => {
        const offset = ontologyPortOffset(side, baseSide, index, sideEdges.length)
        const id = `source-${side}-${baseSide}-${index}`
        const ports = sourcePortsByNode.get(edge.source) ?? []
        ports.push({ id, side, offset })
        sourcePortsByNode.set(edge.source, ports)

        const stepPosition =
          sideEdges.length === 1
            ? 0.5
            : GRAPH_EDGE_LANE_MIN +
              ((GRAPH_EDGE_LANE_MAX - GRAPH_EDGE_LANE_MIN) * index) / (sideEdges.length - 1)
        sourcePortedEdges.set(edge.id, {
          ...edge,
          sourceHandle: id,
          data: edge.data ? { ...edge.data, stepPosition } : undefined,
        })
      })
    }
  }

  return {
    nodes: nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        sourcePorts: sourcePortsByNode.get(node.id) ?? [],
        targetPorts: targetPortsByNode.get(node.id) ?? [],
      },
    })),
    edges: edgesWithTargetPorts.map((edge) => sourcePortedEdges.get(edge.id) ?? edge),
  }
}

function ontologyPortOffset(
  side: OntologyPort["side"],
  baseSide: OntologyPort["side"],
  index: number,
  count: number
): number {
  if (count === 1) return 50
  const reverse =
    (side === "top" && baseSide === "left") || (side === "bottom" && baseSide === "right")
  const orderedIndex = reverse ? count - 1 - index : index
  return (
    GRAPH_PORT_MIN_OFFSET +
    ((GRAPH_PORT_MAX_OFFSET - GRAPH_PORT_MIN_OFFSET) * orderedIndex) / (count - 1)
  )
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - (-2 * value + 2) ** 3 / 2
}

function createOntologyEdge({
  id,
  source,
  target,
  label,
  cardinality,
  positions,
  dashed = false,
}: {
  id: string
  source: string
  target: string
  label: string
  cardinality?: LinkCardinality
  positions: ReadonlyMap<string, { x: number; y: number }>
  dashed?: boolean
}): OntologyEdge {
  const sourceOnLeft = (positions.get(target)?.x ?? 0) < (positions.get(source)?.x ?? 0)
  return {
    id,
    source,
    target,
    sourceHandle: sourceOnLeft ? "source-left" : "source-right",
    targetHandle: sourceOnLeft ? "target-right" : "target-left",
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
    data: { relationshipLabel: label, cardinality, dashed },
  }
}

function collectRelatedTypeIds(edges: OntologyEdge[], selectedTypeId: string): Set<string> {
  const related = new Set<string>()
  for (const edge of edges) {
    if (edge.source === selectedTypeId) related.add(edge.target)
    if (edge.target === selectedTypeId) related.add(edge.source)
  }
  return related
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

  return {
    ...edge,
    label: active && edge.data ? relationshipLabel(edge.data) : undefined,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: emphasized ? "var(--foreground)" : "var(--border)",
    },
    style: {
      ...edge.style,
      stroke: emphasized ? "var(--foreground)" : "var(--border)",
      strokeWidth: emphasized ? 1.4 : 1,
      opacity: !matchesSearch ? 0.08 : selectedTypeId && !active ? 0.1 : 0.8,
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
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
    stepPosition: data?.stepPosition,
  })

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={16} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute whitespace-nowrap rounded-md border border-border/70 bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-700"
            style={{
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

const ontologyEdgeTypes = { ontology: OntologyRelationshipEdge } as unknown as EdgeTypes

function OntologyGraphCard({ data, selected }: NodeProps<OntologyNode>) {
  return (
    <div
      className={cn(
        "flex h-[82px] w-[216px] cursor-pointer flex-col justify-center rounded-xl bg-card px-3.5 shadow-sm transition-[transform,border-color,box-shadow,opacity] duration-200 hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md",
        selected ? "border-2 border-foreground shadow-md" : "border border-border",
        data.relationshipState === "connected" && !selected && "border-foreground/20",
        data.relationshipState === "unrelated" && "opacity-30 hover:opacity-70",
        !data.searchMatch && "opacity-20 hover:opacity-55"
      )}
    >
      <OntologyHandles ports={data.targetPorts} type="target" />
      <OntologyHandles ports={data.sourcePorts} type="source" />
      <Handle
        type="source"
        position={Position.Left}
        id="source-left"
        className="!size-2 !border-0 !bg-transparent !opacity-0"
      />
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
      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        className="!size-2 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  )
}

function OntologyHandles({ ports, type }: { ports: OntologyPort[]; type: "source" | "target" }) {
  return ports.map((port) => {
    const position =
      port.side === "top"
        ? Position.Top
        : port.side === "bottom"
          ? Position.Bottom
          : port.side === "right"
            ? Position.Right
            : Position.Left
    const style =
      port.side === "top" || port.side === "bottom"
        ? { left: `${port.offset}%` }
        : { top: `${port.offset}%` }
    return (
      <Handle
        key={port.id}
        type={type}
        position={position}
        id={port.id}
        style={style}
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

function mostConnectedType(objectTypes: ObjectTypeSummary[]): ObjectTypeSummary | undefined {
  const incoming = new Map<string, number>()
  for (const type of objectTypes) {
    for (const link of type.links) {
      const targets = Array.isArray(link.targetObjectTypeId)
        ? link.targetObjectTypeId
        : [link.targetObjectTypeId]
      for (const target of targets) incoming.set(target, (incoming.get(target) ?? 0) + 1)
    }
  }
  return [...objectTypes].sort(
    (left, right) =>
      right.links.length +
      (incoming.get(right.id) ?? 0) -
      (left.links.length + (incoming.get(left.id) ?? 0))
  )[0]
}
