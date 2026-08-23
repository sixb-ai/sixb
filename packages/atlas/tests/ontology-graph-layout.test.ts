import { describe, expect, test } from "bun:test"
import {
  type GraphEdgeInput,
  type GraphPoint,
  layoutOntologyGraph,
  routeOntologyGraph,
} from "../src/pages/ontologyGraphLayout"

const NODE_WIDTH = 216
const NODE_HEIGHT = 82
const nodes = [
  "building-alarm",
  "customer-account",
  "equipment",
  "facility",
  "field-note",
  "quote",
  "service-case",
  "service-contract",
  "service-visit",
  "technician",
  "work-order",
].map((id) => ({ id, label: id }))

const relationships: Array<[string, string, string]> = [
  ["building-alarm", "equipment", "Equipment · 1"],
  ["equipment", "facility", "Facility · 1"],
  ["facility", "customer-account", "Customer · 1"],
  ["field-note", "service-visit", "Visit · 1"],
  ["field-note", "equipment", "Equipment · 1"],
  ["field-note", "technician", "Author · 1"],
  ["quote", "customer-account", "Customer · 1"],
  ["quote", "facility", "Facility · 1"],
  ["quote", "service-case", "Service Case · 1"],
  ["quote", "service-visit", "Originating Visit · 1"],
  ["service-case", "customer-account", "Customer · 1"],
  ["service-case", "facility", "Facility · 1"],
  ["service-case", "equipment", "Equipment · 1"],
  ["service-case", "service-contract", "Applied Contract · 1"],
  ["service-case", "building-alarm", "Originating Alarms · many"],
  ["service-contract", "customer-account", "Customer · 1"],
  ["service-contract", "facility", "Covered Facilities · many"],
  ["service-visit", "work-order", "Work Order · 1"],
  ["service-visit", "technician", "Technician · 1"],
  ["work-order", "service-case", "Service Case · 1"],
  ["work-order", "equipment", "Equipment · 1"],
  ["work-order", "technician", "Assignee · 1"],
]
const edges: GraphEdgeInput[] = relationships.map(([source, target, label], index) => ({
  id: `edge-${index}`,
  source,
  target,
  labelWidth: Math.max(48, label.length * 6.2 + 16),
}))

describe("ontology graph layout", () => {
  test("leaves room between rows for relationship badges", () => {
    const layout = layoutOntologyGraph(nodes, edges, "equipment", {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    })
    const columns = new Map<number, number[]>()
    for (const node of layout.nodes) {
      const column = columns.get(node.position.x) ?? []
      column.push(node.position.y)
      columns.set(node.position.x, column)
    }

    for (const column of columns.values()) {
      const rows = column.sort((left, right) => left - right)
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index]! - rows[index - 1]!).toBeGreaterThanOrEqual(NODE_HEIGHT + 70)
      }
    }
  })

  for (const { id: focusId } of nodes) {
    test(`keeps the complete ${focusId} view readable`, () => {
      const layout = layoutOntologyGraph(nodes, edges, focusId, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
      })

      expect(layout.nodes).toHaveLength(nodes.length)
      expect(layout.edges).toHaveLength(edges.length)
      expect(layout.nodes.find((node) => node.id === focusId)?.position.x).toBe(NODE_WIDTH + 260)
      for (const edge of layout.edges) {
        const input = edges.find((candidate) => candidate.id === edge.id)!
        if (input.source === focusId || input.target === focusId) {
          expect(edge.points.length).toBeLessThanOrEqual(4)
        }
      }
      expectReadable(layout)
    })
  }

  test("globally reroutes after nodes are moved without restoring their positions", () => {
    const focusId = "service-case"
    const canonical = layoutOntologyGraph(nodes, edges, focusId, {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    })
    const movedPositions = new Map(
      canonical.nodes.map((node) => [
        node.id,
        node.id === focusId
          ? { x: node.position.x + 72, y: node.position.y + 34 }
          : node.id === "quote"
            ? { x: node.position.x - 48, y: node.position.y - 42 }
            : node.position,
      ])
    )
    const rerouted = routeOntologyGraph(
      nodes.map((node) => ({ ...node, position: movedPositions.get(node.id)! })),
      edges,
      focusId,
      { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT }
    )

    expect(rerouted.nodes.find((node) => node.id === focusId)?.position).toEqual(
      movedPositions.get(focusId)
    )
    expect(rerouted.nodes.find((node) => node.id === "quote")?.position).toEqual(
      movedPositions.get("quote")
    )
    expectReadable(rerouted)
  })

  test("fans dense focus handles across the selected node", () => {
    for (const focusId of ["service-case", "equipment"]) {
      const layout = layoutOntologyGraph(nodes, edges, focusId, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
      })
      const focus = layout.nodes.find((node) => node.id === focusId)!
      const offsets = [...focus.sourceHandles, ...focus.targetHandles].map(
        (handle) => handle.offset
      )

      expect(Math.min(...offsets)).toBe(10)
      expect(Math.max(...offsets)).toBe(90)
    }
  })

  test("keeps Quote and Work Order on separate incoming tracks", () => {
    const layout = layoutOntologyGraph(nodes, edges, "service-case", {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    })
    const tracks = ["edge-8", "edge-19"].map((edgeId) => {
      const route = layout.edges.find((edge) => edge.id === edgeId)!
      return segments(route.points).find((segment) => segment.a.x === segment.b.x)!.a.x
    })

    expect(Math.abs(tracks[0]! - tracks[1]!)).toBeGreaterThanOrEqual(32)
  })

  test("keeps Facility incoming relationships from crossing", () => {
    const layout = layoutOntologyGraph(nodes, edges, "facility", {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    })
    const incoming = ["edge-1", "edge-7", "edge-11", "edge-16"].map((edgeId) =>
      segments(layout.edges.find((edge) => edge.id === edgeId)!.points)
    )
    const crossings: string[] = []
    for (let left = 0; left < incoming.length; left += 1) {
      for (let right = left + 1; right < incoming.length; right += 1) {
        if (incoming[left]!.some((a) => incoming[right]!.some((b) => crosses(a, b)))) {
          crossings.push(`${left}:${right}`)
        }
      }
    }

    expect(crossings).toEqual([])
  })
})

function expectReadable(layout: ReturnType<typeof layoutOntologyGraph>): void {
  const nodeRects = new Map(
    layout.nodes.map((node) => [
      node.id,
      { ...node.position, width: NODE_WIDTH, height: NODE_HEIGHT },
    ])
  )
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]))
  const routedSegments = layout.edges.map((edge) => ({
    edge,
    segments: segments(edge.points),
  }))

  const blockedEdges: string[] = []
  for (const { edge, segments: path } of routedSegments) {
    const input = edgeById.get(edge.id)!
    for (const [nodeId, rect] of nodeRects) {
      if (nodeId === input.source || nodeId === input.target) continue
      if (path.some((segment) => hitsRect(segment, expand(rect, 13)))) {
        blockedEdges.push(`${edge.id}:${nodeId}`)
      }
    }
  }
  expect(blockedEdges).toEqual([])

  const overlappingEdges: string[] = []
  for (let left = 0; left < routedSegments.length; left += 1) {
    for (let right = left + 1; right < routedSegments.length; right += 1) {
      if (
        routedSegments[left]!.segments.some((first) =>
          routedSegments[right]!.segments.some((second) => overlaps(first, second))
        )
      ) {
        overlappingEdges.push(`${routedSegments[left]!.edge.id}:${routedSegments[right]!.edge.id}`)
      }
    }
  }
  expect(overlappingEdges).toEqual([])

  const labels = layout.edges.map((edge) => {
    const width = edgeById.get(edge.id)!.labelWidth
    return {
      id: edge.id,
      x: edge.labelPosition.x - width / 2,
      y: edge.labelPosition.y - 11,
      width,
      height: 22,
    }
  })
  const blockedLabels = labels.flatMap((label) =>
    [...nodeRects]
      .filter(([, node]) => rectsOverlap(label, node))
      .map(([nodeId]) => `${label.id}:${nodeId}`)
  )
  expect(blockedLabels).toEqual([])
  const overlappingLabels: string[] = []
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      if (rectsOverlap(labels[left]!, labels[right]!)) {
        overlappingLabels.push(`${labels[left]!.id}:${labels[right]!.id}`)
      }
    }
  }
  expect(overlappingLabels).toEqual([])
}

interface Rect extends GraphPoint {
  width: number
  height: number
}

interface Segment {
  a: GraphPoint
  b: GraphPoint
}

function segments(points: GraphPoint[]): Segment[] {
  return points.slice(1).map((point, index) => ({ a: points[index]!, b: point }))
}

function hitsRect(segment: Segment, rect: Rect): boolean {
  if (segment.a.x === segment.b.x) {
    return (
      segment.a.x > rect.x &&
      segment.a.x < rect.x + rect.width &&
      rangesOverlap(segment.a.y, segment.b.y, rect.y, rect.y + rect.height)
    )
  }
  return (
    segment.a.y > rect.y &&
    segment.a.y < rect.y + rect.height &&
    rangesOverlap(segment.a.x, segment.b.x, rect.x, rect.x + rect.width)
  )
}

function overlaps(left: Segment, right: Segment): boolean {
  if (left.a.x === left.b.x && right.a.x === right.b.x && left.a.x === right.a.x) {
    return overlapLength(left.a.y, left.b.y, right.a.y, right.b.y) > 1
  }
  if (left.a.y === left.b.y && right.a.y === right.b.y && left.a.y === right.a.y) {
    return overlapLength(left.a.x, left.b.x, right.a.x, right.b.x) > 1
  }
  return false
}

function crosses(left: Segment, right: Segment): boolean {
  const horizontal = left.a.y === left.b.y ? left : right.a.y === right.b.y ? right : null
  const vertical = left.a.x === left.b.x ? left : right.a.x === right.b.x ? right : null
  if (!horizontal || !vertical) return false
  return (
    between(vertical.a.x, horizontal.a.x, horizontal.b.x) &&
    between(horizontal.a.y, vertical.a.y, vertical.b.y)
  )
}

function expand(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  }
}

function rectsOverlap(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

function rangesOverlap(a: number, b: number, c: number, d: number): boolean {
  return Math.max(Math.min(a, b), Math.min(c, d)) < Math.min(Math.max(a, b), Math.max(c, d))
}

function overlapLength(a: number, b: number, c: number, d: number): number {
  return Math.max(
    0,
    Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d))
  )
}

function between(value: number, a: number, b: number): boolean {
  return value > Math.min(a, b) && value < Math.max(a, b)
}
