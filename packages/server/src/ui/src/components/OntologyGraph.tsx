import { useEffect, useMemo, useRef, useState } from "react"
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d"
import { useTheme } from "../hooks/useTheme"
import { Badge } from "./ui/badge"

interface ObjectTypeSummary {
  id: string
  name: string
  extends?: string
  properties: { id: string }[]
  links: { id: string; name: string; targetObjectTypeId: string | string[] }[]
  actions: { id: string }[]
}

interface OntologyGraphProps {
  objectTypes: ObjectTypeSummary[]
  onSelectType: (typeId: string) => void
}

interface TypeGraphNode {
  id: string
  label: string
  hasParent: boolean
  propertyCount: number
  linkCount: number
  x?: number
  y?: number
  fx?: number
  fy?: number
}

interface TypeGraphLink {
  source: string
  target: string
  label: string
  kind: "link" | "extends"
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function colorForIndex(index: number, theme: "light" | "dark"): string {
  const palette =
    theme === "dark"
      ? ["#22d3ee", "#38bdf8", "#a78bfa", "#fb7185", "#34d399", "#fbbf24", "#f472b6", "#60a5fa"]
      : ["#0891b2", "#0369a1", "#7c3aed", "#be123c", "#047857", "#a16207", "#db2777", "#2563eb"]
  return palette[index % palette.length]
}

export function OntologyGraph({ objectTypes, onSelectType }: OntologyGraphProps) {
  const { resolvedTheme } = useTheme()
  const graphRef = useRef<ForceGraphMethods<TypeGraphNode, TypeGraphLink> | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [{ width, height }, setViewport] = useState({ width: 0, height: 0 })
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [pinnedPositions, setPinnedPositions] = useState<Record<string, { x: number; y: number }>>(
    {}
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

  const graphData = useMemo(() => {
    const typeIds = new Set(objectTypes.map((t) => t.id))
    const typeIndexById = new Map(objectTypes.map((t, i) => [t.id, i]))

    const nodes: TypeGraphNode[] = objectTypes.map((t) => ({
      id: t.id,
      label: t.name || t.id,
      hasParent: !!t.extends,
      propertyCount: t.properties.length,
      linkCount: t.links.length,
      ...(pinnedPositions[t.id] ?? {}),
      ...(pinnedPositions[t.id]
        ? { fx: pinnedPositions[t.id].x, fy: pinnedPositions[t.id].y }
        : {}),
    }))

    const linkSet = new Set<string>()
    const links: TypeGraphLink[] = []

    for (const t of objectTypes) {
      // extends edges
      if (t.extends && typeIds.has(t.extends)) {
        const key = `extends:${t.id}:${t.extends}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          links.push({ source: t.id, target: t.extends, label: "extends", kind: "extends" })
        }
      }

      // link edges
      for (const link of t.links) {
        const targets = Array.isArray(link.targetObjectTypeId)
          ? link.targetObjectTypeId
          : [link.targetObjectTypeId]
        for (const targetId of targets) {
          if (targetId === "*" || !typeIds.has(targetId)) continue
          const key = `link:${t.id}:${targetId}:${link.id}`
          if (!linkSet.has(key)) {
            linkSet.add(key)
            links.push({
              source: t.id,
              target: targetId,
              label: link.name || link.id,
              kind: "link",
            })
          }
        }
      }
    }

    return { nodes, links, typeIndexById }
  }, [objectTypes, pinnedPositions])

  const palette = useMemo(
    () =>
      resolvedTheme === "dark"
        ? {
            text: "#e2e8f0",
            labelBg: "rgba(15, 23, 42, 0.8)",
            nodeStroke: "#0f172a",
            link: "rgba(148, 163, 184, 0.42)",
            extends: "rgba(167, 139, 250, 0.6)",
          }
        : {
            text: "#0f172a",
            labelBg: "rgba(241, 245, 249, 0.9)",
            nodeStroke: "#ffffff",
            link: "rgba(71, 85, 105, 0.32)",
            extends: "rgba(124, 58, 237, 0.5)",
          },
    [resolvedTheme]
  )

  useEffect(() => {
    if (!graphRef.current || width <= 0 || height <= 0 || graphData.nodes.length === 0) return

    const timer = setTimeout(() => {
      graphRef.current?.zoomToFit(300, 60)
    }, 200)

    return () => clearTimeout(timer)
  }, [graphData.nodes.length, width, height])

  const linkCount = graphData.links.filter((l) => l.kind === "link").length
  const extendsCount = graphData.links.filter((l) => l.kind === "extends").length

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/80 shadow-sm">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,hsl(var(--primary)/0.18),transparent_52%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.2)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.2)_1px,transparent_1px)] bg-[size:28px_28px]" />

      <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className="border-primary/50 bg-primary/10 text-[10px] text-foreground"
        >
          Type Graph
        </Badge>
        <Badge variant="outline" className="border-border/70 bg-card/70 text-[10px]">
          {objectTypes.length} types
        </Badge>
        {linkCount > 0 && (
          <Badge variant="outline" className="border-border/70 bg-card/70 text-[10px]">
            {linkCount} links
          </Badge>
        )}
        {extendsCount > 0 && (
          <Badge variant="outline" className="border-border/70 bg-card/70 text-[10px]">
            {extendsCount} extends
          </Badge>
        )}
      </div>

      <div
        ref={containerRef}
        className="relative h-[68vh] min-h-[460px] max-h-[820px] sm:min-h-[580px]"
      >
        {width > 0 && height > 0 && (
          <ForceGraph2D<TypeGraphNode, TypeGraphLink>
            ref={graphRef}
            width={width}
            height={height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            nodeLabel={(node) =>
              `${node.label}\n${node.propertyCount} props, ${node.linkCount} links`
            }
            nodeCanvasObject={(node, context, globalScale) => {
              const x = node.x ?? 0
              const y = node.y ?? 0
              const baseRadius = clamp(6 + node.propertyCount * 0.3, 6, 14)
              const radius = hoveredNodeId === node.id ? baseRadius + 2 : baseRadius
              const nodeIndex = graphData.typeIndexById.get(node.id) ?? 0
              const showLabel = graphData.nodes.length <= 16 || hoveredNodeId === node.id

              context.beginPath()
              context.arc(x, y, radius, 0, 2 * Math.PI, false)
              context.fillStyle = colorForIndex(nodeIndex, resolvedTheme)
              context.fill()

              context.lineWidth = Math.max(1, 2 / globalScale)
              context.strokeStyle = palette.nodeStroke
              context.stroke()

              if (!showLabel) return

              const fontSize = Math.max(10, 12 / globalScale)
              context.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI`
              context.textAlign = "center"
              context.textBaseline = "middle"

              const text = node.label
              const textWidth = context.measureText(text).width
              const labelPadX = 5 / globalScale
              const labelPadY = 3 / globalScale
              const labelHeight = fontSize + labelPadY * 2
              const labelY = y - radius - 10 / globalScale

              context.fillStyle = palette.labelBg
              context.fillRect(
                x - textWidth / 2 - labelPadX,
                labelY - labelHeight / 2,
                textWidth + labelPadX * 2,
                labelHeight
              )

              context.fillStyle = palette.text
              context.fillText(text, x, labelY)
            }}
            nodePointerAreaPaint={(node, color, context) => {
              const x = node.x ?? 0
              const y = node.y ?? 0
              context.fillStyle = color
              context.beginPath()
              context.arc(x, y, 22, 0, 2 * Math.PI, false)
              context.fill()
            }}
            linkLabel={(link) => link.label}
            linkColor={(link) => (link.kind === "extends" ? palette.extends : palette.link)}
            linkWidth={(link) => (link.kind === "extends" ? 2.2 : 1.5)}
            linkLineDash={(link) => (link.kind === "extends" ? [6, 3] : [])}
            linkDirectionalArrowLength={6}
            linkDirectionalArrowRelPos={0.85}
            onNodeHover={(node) => {
              setHoveredNodeId(typeof node?.id === "string" ? node.id : null)
            }}
            onNodeClick={(node) => {
              if (typeof node.id !== "string") return
              onSelectType(node.id)
            }}
            onNodeDragEnd={(node) => {
              if (typeof node.id !== "string") return
              const x = typeof node.x === "number" ? node.x : 0
              const y = typeof node.y === "number" ? node.y : 0
              node.fx = x
              node.fy = y
              setPinnedPositions((prev) => ({ ...prev, [node.id]: { x, y } }))
            }}
            showPointerCursor={(obj) =>
              Boolean(obj && typeof obj === "object" && "id" in obj && obj.id !== undefined)
            }
            enableNodeDrag
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.3}
            minZoom={0.35}
            maxZoom={2.2}
          />
        )}
      </div>

      {objectTypes.length === 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200">
          No object types defined yet.
        </div>
      )}
    </div>
  )
}
