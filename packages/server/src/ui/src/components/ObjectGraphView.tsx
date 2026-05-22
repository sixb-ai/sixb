import type { ObjectSummary, RelationshipEdge } from "@pario/client"
import { useEffect, useMemo, useRef, useState } from "react"
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d"
import { useTheme } from "../hooks/useTheme"
import { humanizeIdentifier } from "../lib/labels"
import { Badge } from "./ui/badge"

interface ObjectGraphViewProps {
  objects: ObjectSummary[]
  relationships: RelationshipEdge[]
  selectedObjectId: string | null
  onSelectObject: (id: string) => void
}

interface GraphNode {
  id: string
  label: string
  class: string
  selected: boolean
  degree: number
  centerX: number
  centerY: number
  x?: number
  y?: number
  fx?: number
  fy?: number
}

interface GraphLink {
  source: string
  target: string
  type: string
  active: boolean
  weight: number
}

function colorForObjectClass(objectClass: string, theme: "light" | "dark"): string {
  if (objectClass.includes("computer")) return theme === "dark" ? "#22d3ee" : "#0891b2"
  if (objectClass.includes("processor")) return theme === "dark" ? "#38bdf8" : "#0369a1"
  if (objectClass.includes("memory")) return theme === "dark" ? "#f59e0b" : "#b45309"
  if (objectClass.includes("storage")) return theme === "dark" ? "#10b981" : "#047857"
  if (objectClass.includes("network")) return theme === "dark" ? "#0ea5e9" : "#075985"
  if (objectClass.includes("battery")) return theme === "dark" ? "#eab308" : "#a16207"
  if (objectClass.includes("graphics") || objectClass.includes("gpu")) {
    return theme === "dark" ? "#fb7185" : "#be123c"
  }
  return theme === "dark" ? "#94a3b8" : "#475569"
}

function pairKeyFor(source: string, target: string): string {
  return source < target ? `${source}|${target}` : `${target}|${source}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function buildComponents(nodeIds: string[], links: GraphLink[]): string[][] {
  const adjacency = new Map<string, Set<string>>()
  for (const id of nodeIds) {
    adjacency.set(id, new Set())
  }

  for (const link of links) {
    adjacency.get(link.source)?.add(link.target)
    adjacency.get(link.target)?.add(link.source)
  }

  const visited = new Set<string>()
  const components: string[][] = []

  for (const nodeId of [...nodeIds].sort()) {
    if (visited.has(nodeId)) continue

    const queue = [nodeId]
    const component: string[] = []
    visited.add(nodeId)

    while (queue.length > 0) {
      const current = queue.shift()!
      component.push(current)
      const neighbors = [...(adjacency.get(current) ?? [])].sort()
      for (const next of neighbors) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }

    components.push(component)
  }

  return components
}

function buildLevels(
  ids: string[],
  links: GraphLink[],
  selectedObjectId: string | null,
  degreeByObjectId: Map<string, number>
): string[][] {
  const adjacency = new Map<string, Set<string>>()
  for (const id of ids) {
    adjacency.set(id, new Set())
  }

  for (const link of links) {
    if (!adjacency.has(link.source) || !adjacency.has(link.target)) continue
    adjacency.get(link.source)?.add(link.target)
    adjacency.get(link.target)?.add(link.source)
  }

  const root =
    (selectedObjectId && ids.includes(selectedObjectId) ? selectedObjectId : null) ??
    ids.slice().sort((left, right) => {
      const degreeDelta = (degreeByObjectId.get(right) ?? 0) - (degreeByObjectId.get(left) ?? 0)
      if (degreeDelta !== 0) return degreeDelta
      return left.localeCompare(right)
    })[0]

  if (!root) return []

  const visited = new Set<string>([root])
  const levels: string[][] = [[root]]

  while (visited.size < ids.length) {
    const previousLevel = levels[levels.length - 1] ?? []
    const nextSet = new Set<string>()

    for (const nodeId of previousLevel) {
      const neighbors = [...(adjacency.get(nodeId) ?? [])].sort((left, right) => {
        const degreeDelta = (degreeByObjectId.get(right) ?? 0) - (degreeByObjectId.get(left) ?? 0)
        if (degreeDelta !== 0) return degreeDelta
        return left.localeCompare(right)
      })
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue
        nextSet.add(neighbor)
      }
    }

    if (nextSet.size === 0) {
      const remainder = ids.filter((id) => !visited.has(id)).sort()
      levels.push(remainder)
      for (const id of remainder) visited.add(id)
      break
    }

    const nextLevel = [...nextSet]
    levels.push(nextLevel)
    for (const id of nextLevel) visited.add(id)
  }

  return levels
}

export function ObjectGraphView({
  objects,
  relationships,
  selectedObjectId,
  onSelectObject,
}: ObjectGraphViewProps) {
  const { resolvedTheme } = useTheme()
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [{ width, height }, setViewport] = useState({ width: 0, height: 0 })
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [pinnedPositions, setPinnedPositions] = useState<Record<string, { x: number; y: number }>>(
    {}
  )

  const layoutWidth = width > 0 ? width : 1200
  const layoutHeight = height > 0 ? height : 700

  useEffect(() => {
    const objectIds = new Set(objects.map((obj) => obj.id))
    setPinnedPositions((previous) => {
      const nextEntries = Object.entries(previous).filter(([id]) => objectIds.has(id))
      if (nextEntries.length === Object.keys(previous).length) return previous
      return Object.fromEntries(nextEntries)
    })
  }, [objects])

  const graphData = useMemo(() => {
    const objectIds = new Set(objects.map((obj) => obj.id))
    const mergedLinks = new Map<
      string,
      {
        source: string
        target: string
        types: Set<string>
        active: boolean
        weight: number
      }
    >()

    for (const relationship of relationships) {
      if (!objectIds.has(relationship.source) || !objectIds.has(relationship.target)) continue
      const key = pairKeyFor(relationship.source, relationship.target)
      const existing = mergedLinks.get(key)

      if (!existing) {
        mergedLinks.set(key, {
          source: relationship.source,
          target: relationship.target,
          types: new Set([relationship.type]),
          active:
            selectedObjectId === relationship.source || selectedObjectId === relationship.target,
          weight: 1,
        })
        continue
      }

      existing.types.add(relationship.type)
      existing.active =
        existing.active ||
        selectedObjectId === relationship.source ||
        selectedObjectId === relationship.target
      existing.weight += 1
    }

    const links: GraphLink[] = [...mergedLinks.values()].map((entry) => ({
      source: entry.source,
      target: entry.target,
      type: [...entry.types].sort().slice(0, 2).join(" / "),
      active: entry.active,
      weight: entry.weight,
    }))

    const degreeByObjectId = new Map<string, number>()
    for (const link of links) {
      degreeByObjectId.set(link.source, (degreeByObjectId.get(link.source) ?? 0) + 1)
      degreeByObjectId.set(link.target, (degreeByObjectId.get(link.target) ?? 0) + 1)
    }

    const allNodeIds = objects.map((obj) => obj.id)
    const components = buildComponents(allNodeIds, links)

    const perComponentCenters: Array<{ x: number; y: number; ids: string[] }> = []

    if (components.length === 1) {
      perComponentCenters.push({ x: 0, y: 0, ids: components[0] })
    } else {
      const columns = Math.ceil(Math.sqrt(components.length))
      const rows = Math.ceil(components.length / columns)
      const componentGap = clamp(Math.min(layoutWidth, layoutHeight) * 0.8, 320, 760)

      components.forEach((ids, index) => {
        const row = Math.floor(index / columns)
        const column = index % columns
        perComponentCenters.push({
          x: (column - (columns - 1) / 2) * componentGap,
          y: (row - (rows - 1) / 2) * componentGap,
          ids,
        })
      })
    }

    const objectById = new Map(objects.map((obj) => [obj.id, obj]))
    const positionedNodes = new Map<string, GraphNode>()

    const ringGap = clamp(Math.min(layoutWidth, layoutHeight) * 0.28, 160, 260)

    for (const component of perComponentCenters) {
      const levels = buildLevels(component.ids, links, selectedObjectId, degreeByObjectId)

      levels.forEach((level, levelIndex) => {
        const radius = levelIndex === 0 ? 0 : levelIndex * ringGap
        const count = level.length
        const offset = levelIndex * 0.42

        level.forEach((id, index) => {
          const obj = objectById.get(id)
          if (!obj) return

          const angle = count <= 1 ? 0 : (index / count) * Math.PI * 2 + offset
          const x = component.x + Math.cos(angle) * radius
          const y = component.y + Math.sin(angle) * radius

          positionedNodes.set(id, {
            id,
            label: obj.name || humanizeIdentifier(id),
            class: obj.class,
            selected: selectedObjectId === id,
            degree: degreeByObjectId.get(id) ?? 0,
            centerX: component.x,
            centerY: component.y,
            x: pinnedPositions[id]?.x ?? x,
            y: pinnedPositions[id]?.y ?? y,
            fx: pinnedPositions[id]?.x ?? x,
            fy: pinnedPositions[id]?.y ?? y,
          })
        })
      })
    }

    const nodes = allNodeIds
      .map((id) => positionedNodes.get(id))
      .filter((node): node is GraphNode => Boolean(node))

    return { nodes, links }
  }, [objects, relationships, selectedObjectId, layoutWidth, layoutHeight, pinnedPositions])

  const relationshipCount = graphData.links.length

  const palette = useMemo(
    () =>
      resolvedTheme === "dark"
        ? {
            text: "#e2e8f0",
            labelBg: "rgba(15, 23, 42, 0.8)",
            nodeStroke: "#0f172a",
            selected: "#f8fafc",
            link: "rgba(148, 163, 184, 0.42)",
            linkActive: "rgba(251, 113, 133, 0.95)",
          }
        : {
            text: "#0f172a",
            labelBg: "rgba(241, 245, 249, 0.9)",
            nodeStroke: "#ffffff",
            selected: "#0f172a",
            link: "rgba(71, 85, 105, 0.32)",
            linkActive: "rgba(225, 29, 72, 0.85)",
          },
    [resolvedTheme]
  )

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect
      if (!next) return
      setViewport({
        width: Math.max(1, Math.round(next.width)),
        height: Math.max(1, Math.round(next.height)),
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!graphRef.current || width <= 0 || height <= 0 || graphData.nodes.length === 0) return

    const xs = graphData.nodes.map((node) => node.x ?? 0)
    const ys = graphData.nodes.map((node) => node.y ?? 0)

    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const padding = 140

    const fitScaleX = Math.max(0.1, (width - padding * 2) / spanX)
    const fitScaleY = Math.max(0.1, (height - padding * 2) / spanY)
    const zoom = clamp(Math.min(fitScaleX, fitScaleY), 0.62, 1.05)

    graphRef.current.centerAt(centerX, centerY, 250)
    graphRef.current.zoom(zoom, 250)
  }, [graphData, width, height])

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/80 shadow-sm">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,hsl(var(--primary)/0.18),transparent_52%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.2)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.2)_1px,transparent_1px)] bg-[size:28px_28px]" />

      <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className="border-primary/50 bg-primary/10 text-[10px] text-foreground"
        >
          Graph
        </Badge>
        <Badge variant="outline" className="border-border/70 bg-card/70 text-[10px]">
          {objects.length} nodes
        </Badge>
        <Badge variant="outline" className="border-border/70 bg-card/70 text-[10px]">
          {relationshipCount} links
        </Badge>
      </div>

      <div
        ref={containerRef}
        className="relative h-[68vh] min-h-[460px] max-h-[820px] sm:min-h-[580px]"
      >
        {width > 0 && height > 0 && (
          <ForceGraph2D<GraphNode, GraphLink>
            ref={graphRef}
            width={width}
            height={height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            nodeLabel={(node) => `${node.label}\n${node.class}`}
            nodeCanvasObject={(node, context, globalScale) => {
              const x = node.x ?? 0
              const y = node.y ?? 0
              const radius = node.selected ? 9 : 6.8
              const text = node.label
              const showLabel =
                graphData.nodes.length <= 10 || node.selected || hoveredNodeId === node.id

              context.beginPath()
              context.arc(x, y, radius, 0, 2 * Math.PI, false)
              context.fillStyle = node.selected
                ? palette.selected
                : colorForObjectClass(node.class, resolvedTheme)
              context.fill()

              context.lineWidth = Math.max(1, 2 / globalScale)
              context.strokeStyle = palette.nodeStroke
              context.stroke()

              if (!showLabel) return

              const fontSize = Math.max(10, 12 / globalScale)
              context.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI`
              context.textAlign = "center"
              context.textBaseline = "middle"

              const textWidth = context.measureText(text).width
              const labelPadX = 5 / globalScale
              const labelPadY = 3 / globalScale
              const labelHeight = fontSize + labelPadY * 2

              const dx = x - node.centerX
              const dy = y - node.centerY
              const length = Math.hypot(dx, dy)
              const nx = length > 0.0001 ? dx / length : 0
              const ny = length > 0.0001 ? dy / length : -1
              const labelDistance = radius + 10 / globalScale
              const labelX = x + nx * labelDistance
              const labelY = y + ny * labelDistance

              context.fillStyle = palette.labelBg
              context.fillRect(
                labelX - textWidth / 2 - labelPadX,
                labelY - labelHeight / 2,
                textWidth + labelPadX * 2,
                labelHeight
              )

              context.fillStyle = palette.text
              context.fillText(text, labelX, labelY)
            }}
            nodePointerAreaPaint={(node, color, context) => {
              const x = node.x ?? 0
              const y = node.y ?? 0
              context.fillStyle = color
              context.beginPath()
              context.arc(x, y, 22, 0, 2 * Math.PI, false)
              context.fill()
            }}
            linkLabel={(link) => link.type}
            linkColor={(link) => (link.active ? palette.linkActive : palette.link)}
            linkWidth={(link) => (link.active ? 2.8 : Math.min(2.2, 1.2 + link.weight * 0.3))}
            onNodeHover={(node) => {
              setHoveredNodeId(typeof node?.id === "string" ? node.id : null)
            }}
            onNodeClick={(node) => {
              if (typeof node.id !== "string") return
              onSelectObject(node.id)
            }}
            onNodeDragEnd={(node) => {
              if (typeof node.id !== "string") return
              const x = typeof node.x === "number" ? node.x : 0
              const y = typeof node.y === "number" ? node.y : 0
              node.fx = x
              node.fy = y
              setPinnedPositions((previous) => ({
                ...previous,
                [node.id]: { x, y },
              }))
            }}
            showPointerCursor={(obj) =>
              Boolean(obj && typeof obj === "object" && "id" in obj && obj.id !== undefined)
            }
            enableNodeDrag
            warmupTicks={0}
            cooldownTicks={0}
            d3AlphaDecay={1}
            d3VelocityDecay={1}
            minZoom={0.35}
            maxZoom={2.2}
          />
        )}
      </div>

      {relationshipCount === 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200">
          No relationships yet. Define object relationships to connect nodes.
        </div>
      )}
    </div>
  )
}
