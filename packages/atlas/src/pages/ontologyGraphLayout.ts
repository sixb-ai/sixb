export interface GraphPoint {
  x: number
  y: number
}

export interface GraphNodeInput {
  id: string
  label: string
}

export interface GraphPositionedNodeInput extends GraphNodeInput {
  position: GraphPoint
}

export interface GraphEdgeInput {
  id: string
  source: string
  target: string
  labelWidth: number
}

export type GraphHandleSide = "bottom" | "left" | "right" | "top"

export interface GraphHandleLayout {
  id: string
  offset: number
  side: GraphHandleSide
}

export interface GraphNodeLayout {
  id: string
  position: GraphPoint
  sourceHandles: GraphHandleLayout[]
  targetHandles: GraphHandleLayout[]
}

export interface GraphEdgeLayout {
  id: string
  sourceHandle: string
  targetHandle: string
  points: GraphPoint[]
  labelPosition: GraphPoint
}

interface GraphLayoutOptions {
  nodeWidth: number
  nodeHeight: number
  columnGap?: number
  rowGap?: number
}

interface Rect extends GraphPoint {
  width: number
  height: number
}

interface Segment {
  a: GraphPoint
  b: GraphPoint
}

interface EdgeHandles {
  source: GraphHandleLayout
  target: GraphHandleLayout
}

const PORT_MIN = 18
const PORT_MAX = 82
const ROUTE_GAP = 14
const FOCUS_ROUTE_GAP = 32
const NODE_CLEARANCE = 14

export function layoutOntologyGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  focusId: string,
  { nodeWidth, nodeHeight, columnGap = 260, rowGap = 70 }: GraphLayoutOptions
): { nodes: GraphNodeLayout[]; edges: GraphEdgeLayout[]; bounds: Rect } {
  const columns = partitionNodes(nodes, edges, focusId)
  orderColumns(columns, edges)

  const rowPitch = nodeHeight + rowGap
  const columnPitch = nodeWidth + columnGap
  const rowCount = Math.max(...columns.map((column) => column.length), 1)
  const positions = new Map<string, GraphPoint>()
  const columnById = new Map<string, number>()

  columns.forEach((column, columnIndex) => {
    const start = ((rowCount - column.length) * rowPitch) / 2
    column.forEach((nodeId, rowIndex) => {
      positions.set(nodeId, { x: columnIndex * columnPitch, y: start + rowIndex * rowPitch })
      columnById.set(nodeId, columnIndex)
    })
  })

  return routePositionedGraph(
    nodes,
    edges,
    focusId,
    { nodeWidth, nodeHeight },
    positions,
    columnById
  )
}

export function routeOntologyGraph(
  nodes: GraphPositionedNodeInput[],
  edges: GraphEdgeInput[],
  focusId: string,
  { nodeWidth, nodeHeight }: GraphLayoutOptions
): { nodes: GraphNodeLayout[]; edges: GraphEdgeLayout[]; bounds: Rect } {
  const positions = new Map(nodes.map((node) => [node.id, node.position]))
  const focus = positions.get(focusId) ?? nodes[0]?.position ?? { x: 0, y: 0 }
  const focusCenter = focus.x + nodeWidth / 2
  const columnById = new Map(
    nodes.map((node) => {
      const center = node.position.x + nodeWidth / 2
      const column =
        center < focusCenter - nodeWidth / 2 ? 0 : center > focusCenter + nodeWidth / 2 ? 2 : 1
      return [node.id, column]
    })
  )
  columnById.set(focusId, 1)

  return routePositionedGraph(
    nodes,
    edges,
    focusId,
    { nodeWidth, nodeHeight },
    positions,
    columnById
  )
}

function routePositionedGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  focusId: string,
  { nodeWidth, nodeHeight }: Pick<GraphLayoutOptions, "nodeWidth" | "nodeHeight">,
  positions: ReadonlyMap<string, GraphPoint>,
  columnById: ReadonlyMap<string, number>
): { nodes: GraphNodeLayout[]; edges: GraphEdgeLayout[]; bounds: Rect } {
  const handles = assignHandles(edges, positions, columnById, focusId)
  const nodeRects = new Map(
    nodes.map((node) => [
      node.id,
      { ...positions.get(node.id)!, width: nodeWidth, height: nodeHeight },
    ])
  )
  const routed = routeEdges(edges, handles, nodeRects, columnById, focusId)
  const labelWidths = new Map(edges.map((edge) => [edge.id, edge.labelWidth]))
  const bounds = layoutBounds([...nodeRects.values()], routed, labelWidths)

  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id)!,
      sourceHandles: edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => handles.get(edge.id)!.source),
      targetHandles: edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => handles.get(edge.id)!.target),
    })),
    edges: routed,
    bounds,
  }
}

function layoutBounds(
  nodes: Rect[],
  edges: GraphEdgeLayout[],
  labelWidths: ReadonlyMap<string, number>
): Rect {
  const left = Math.min(
    ...nodes.map((node) => node.x),
    ...edges.flatMap((edge) => edge.points.map((point) => point.x)),
    ...edges.map((edge) => edge.labelPosition.x - (labelWidths.get(edge.id) ?? 0) / 2)
  )
  const top = Math.min(
    ...nodes.map((node) => node.y),
    ...edges.flatMap((edge) => edge.points.map((point) => point.y)),
    ...edges.map((edge) => edge.labelPosition.y - 11)
  )
  const right = Math.max(
    ...nodes.map((node) => node.x + node.width),
    ...edges.flatMap((edge) => edge.points.map((point) => point.x)),
    ...edges.map((edge) => edge.labelPosition.x + (labelWidths.get(edge.id) ?? 0) / 2)
  )
  const bottom = Math.max(
    ...nodes.map((node) => node.y + node.height),
    ...edges.flatMap((edge) => edge.points.map((point) => point.y)),
    ...edges.map((edge) => edge.labelPosition.y + 11)
  )
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function partitionNodes(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  focusId: string
): string[][] {
  const side = new Map<string, number>([[focusId, 1]])
  for (const edge of edges) {
    if (edge.target === focusId && edge.source !== focusId) side.set(edge.source, 0)
    if (edge.source === focusId && edge.target !== focusId) side.set(edge.target, 2)
  }

  const unresolved = new Set(nodes.map((node) => node.id).filter((id) => !side.has(id)))
  while (unresolved.size > 0) {
    let progressed = false
    for (const id of [...unresolved].sort()) {
      const neighbors = edges.flatMap((edge) =>
        edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : []
      )
      const votes = neighbors
        .map((neighbor) => side.get(neighbor))
        .filter((value): value is number => value === 0 || value === 2)
      if (votes.length === 0) continue
      side.set(id, votes.reduce((total, value) => total + value, 0) < votes.length ? 0 : 2)
      unresolved.delete(id)
      progressed = true
    }
    if (progressed) continue

    const counts = [0, 2].map((value) => [...side.values()].filter((side) => side === value).length)
    for (const id of [...unresolved].sort()) {
      const value = counts[0]! <= counts[1]! ? 0 : 2
      side.set(id, value)
      counts[value === 0 ? 0 : 1]! += 1
      unresolved.delete(id)
    }
  }

  return [0, 1, 2].map((column) =>
    nodes
      .filter((node) => side.get(node.id) === column)
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((node) => node.id)
  )
}

function orderColumns(columns: string[][], edges: GraphEdgeInput[]): void {
  for (let pass = 0; pass < 8; pass += 1) {
    let improved = false
    for (const column of [columns[0]!, columns[2]!]) {
      for (let index = 0; index < column.length - 1; index += 1) {
        const before = orderScore(columns, edges)
        ;[column[index], column[index + 1]] = [column[index + 1]!, column[index]!]
        if (orderScore(columns, edges) < before) improved = true
        else [column[index], column[index + 1]] = [column[index + 1]!, column[index]!]
      }
    }
    if (!improved) break
  }
}

function orderScore(columns: string[][], edges: GraphEdgeInput[]): number {
  const location = new Map<string, { column: number; row: number }>()
  columns.forEach((column, columnIndex) => {
    column.forEach((id, row) => {
      location.set(id, { column: columnIndex, row })
    })
  })
  let score = 0
  for (const edge of edges) {
    const source = location.get(edge.source)
    const target = location.get(edge.target)
    if (!source || !target) continue
    score += Math.abs(source.row - target.row) * (source.column === target.column ? 5 : 1)
  }
  for (let left = 0; left < edges.length; left += 1) {
    const firstSource = location.get(edges[left]!.source)
    const firstTarget = location.get(edges[left]!.target)
    if (!firstSource || !firstTarget || firstSource.column === firstTarget.column) continue
    for (let right = left + 1; right < edges.length; right += 1) {
      const secondSource = location.get(edges[right]!.source)
      const secondTarget = location.get(edges[right]!.target)
      if (!secondSource || !secondTarget) continue
      const firstPair = [firstSource.column, firstTarget.column].sort().join(":")
      const secondPair = [secondSource.column, secondTarget.column].sort().join(":")
      if (firstPair !== secondPair) continue
      const firstRows =
        firstSource.column < firstTarget.column
          ? [firstSource.row, firstTarget.row]
          : [firstTarget.row, firstSource.row]
      const secondRows =
        secondSource.column < secondTarget.column
          ? [secondSource.row, secondTarget.row]
          : [secondTarget.row, secondSource.row]
      if ((firstRows[0]! - secondRows[0]!) * (firstRows[1]! - secondRows[1]!) < 0) score += 40
    }
  }
  return score
}

function assignHandles(
  edges: GraphEdgeInput[],
  positions: ReadonlyMap<string, GraphPoint>,
  columns: ReadonlyMap<string, number>,
  focusId: string
): Map<string, EdgeHandles> {
  const sides = new Map<string, { source: GraphHandleSide; target: GraphHandleSide }>()
  for (const edge of edges) {
    const sourceColumn = columns.get(edge.source) ?? 0
    const targetColumn = columns.get(edge.target) ?? 0
    if (sourceColumn < targetColumn) sides.set(edge.id, { source: "right", target: "left" })
    else if (sourceColumn > targetColumn) sides.set(edge.id, { source: "left", target: "right" })
    else {
      const outside = sourceColumn === 2 ? "right" : "left"
      sides.set(edge.id, { source: outside, target: outside })
    }
  }

  const grouped = new Map<string, { edge: GraphEdgeInput; role: "source" | "target" }[]>()
  for (const edge of edges) {
    for (const role of ["source", "target"] as const) {
      const nodeId = edge[role]
      const side = sides.get(edge.id)![role]
      const key = `${nodeId}:${side}`
      grouped.set(key, [...(grouped.get(key) ?? []), { edge, role }])
    }
  }

  const handles = new Map<string, Partial<EdgeHandles>>()
  for (const group of grouped.values()) {
    group.sort((left, right) => {
      const leftOther = positions.get(left.edge[left.role === "source" ? "target" : "source"])
      const rightOther = positions.get(right.edge[right.role === "source" ? "target" : "source"])
      return (leftOther?.y ?? 0) - (rightOther?.y ?? 0) || left.edge.id.localeCompare(right.edge.id)
    })
    const nodeId = group[0]?.edge[group[0].role]
    const spreadFocus = nodeId === focusId && group.length >= 3
    const min = spreadFocus ? 10 : PORT_MIN
    const max = spreadFocus ? 90 : PORT_MAX
    group.forEach(({ edge, role }, index) => {
      const side = sides.get(edge.id)![role]
      const offset = group.length === 1 ? 50 : min + ((max - min) * index) / (group.length - 1)
      const handle = { id: `${edge.id}:${role}`, side, offset }
      handles.set(edge.id, { ...handles.get(edge.id), [role]: handle })
    })
  }

  return new Map([...handles].map(([id, value]) => [id, value as EdgeHandles]))
}

function routeEdges(
  edges: GraphEdgeInput[],
  handles: ReadonlyMap<string, EdgeHandles>,
  nodes: ReadonlyMap<string, Rect>,
  columns: ReadonlyMap<string, number>,
  focusId: string
): GraphEdgeLayout[] {
  const allRects = [...nodes.values()]
  const bounds = graphBounds(allRects)
  const focusRect = nodes.get(focusId)
  const focusLanes = assignFocusLanes(edges, nodes, columns, focusId)
  const usedSegments: Segment[] = []
  const usedLabels: Rect[] = []
  const groupIndex = new Map<string, number>()

  return [...edges]
    .sort((left, right) => {
      const leftFocus = left.source === focusId || left.target === focusId ? 0 : 1
      const rightFocus = right.source === focusId || right.target === focusId ? 0 : 1
      return (
        leftFocus - rightFocus ||
        (leftFocus === 0 ? right.labelWidth - left.labelWidth : 0) ||
        left.id.localeCompare(right.id)
      )
    })
    .map((edge) => {
      const focused = edge.source === focusId || edge.target === focusId
      const edgeHandles = handles.get(edge.id)!
      const sourceRect = nodes.get(edge.source)!
      const targetRect = nodes.get(edge.target)!
      const start = handlePoint(sourceRect, edgeHandles.source)
      const end = handlePoint(targetRect, edgeHandles.target)
      const sourceColumn = columns.get(edge.source) ?? 0
      const targetColumn = columns.get(edge.target) ?? 0
      const pair = [sourceColumn, targetColumn].sort().join(":")
      const index = groupIndex.get(pair) ?? 0
      groupIndex.set(pair, index + 1)
      const candidates = routeCandidates(
        start,
        end,
        sourceColumn,
        targetColumn,
        index,
        bounds,
        sourceRect,
        targetRect,
        focusRect,
        edge.labelWidth,
        focused,
        focusLanes.get(edge.id)
      )
      const obstacles = allRects.filter((rect) => rect !== sourceRect && rect !== targetRect)
      const points = candidates
        .map(simplifyRoute)
        .map((route) => ({ route, score: routeScore(route, obstacles, usedSegments) }))
        .sort((left, right) => left.score - right.score)[0]?.route ?? [start, end]
      const segments = routeSegments(points)
      usedSegments.push(...segments)
      const labelPosition = placeLabel(segments, edge.labelWidth, allRects, usedLabels)
      usedLabels.push({
        x: labelPosition.x - edge.labelWidth / 2,
        y: labelPosition.y - 11,
        width: edge.labelWidth,
        height: 22,
      })

      return {
        id: edge.id,
        sourceHandle: edgeHandles.source.id,
        targetHandle: edgeHandles.target.id,
        points,
        labelPosition,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

function routeCandidates(
  start: GraphPoint,
  end: GraphPoint,
  sourceColumn: number,
  targetColumn: number,
  index: number,
  bounds: Rect,
  source: Rect,
  target: Rect,
  focus: Rect | undefined,
  labelWidth: number,
  focused: boolean,
  preferredLane?: number
): GraphPoint[][] {
  const gap = focused ? FOCUS_ROUTE_GAP : ROUTE_GAP
  const track = (points: GraphPoint[]) => (focused ? points : trackEndpoints(points, index))
  if (sourceColumn === targetColumn) {
    const direction = sourceColumn === 2 ? 1 : -1
    const labelClearance = Math.max(72, labelWidth / 2 + 22)
    return Array.from({ length: 5 }, (_, lane) => {
      const x =
        direction < 0
          ? bounds.x - labelClearance - (index + lane) * ROUTE_GAP
          : bounds.x + bounds.width + labelClearance + (index + lane) * ROUTE_GAP
      return track([start, { x, y: start.y }, { x, y: end.y }, end])
    })
  }

  const left = sourceColumn < targetColumn ? source : target
  const right = sourceColumn < targetColumn ? target : source
  const laneCenter = (left.x + left.width + right.x) / 2
  const fallbackLanes = Array.from({ length: 7 }, (_, lane) => laneCenter + (lane - 3) * gap)
  const lanes =
    preferredLane === undefined
      ? fallbackLanes
      : [preferredLane, ...fallbackLanes.filter((lane) => Math.abs(lane - preferredLane) > 1)]
  const adjacent = Math.abs(sourceColumn - targetColumn) === 1
  const direct = lanes.map((x) => track([start, { x, y: start.y }, { x, y: end.y }, end]))
  if (adjacent) {
    if (focused) return direct
    const direction = sourceColumn < targetColumn ? 1 : -1
    const startLane = start.x + direction * (26 + (index % 4) * ROUTE_GAP)
    const endLane = end.x - direction * (26 + (index % 4) * ROUTE_GAP)
    const detours = [
      bounds.y - 34 - index * ROUTE_GAP,
      bounds.y + bounds.height + 34 + index * ROUTE_GAP,
    ].map((y) =>
      track([
        start,
        { x: startLane, y: start.y },
        { x: startLane, y },
        { x: endLane, y },
        { x: endLane, y: end.y },
        end,
      ])
    )
    return [...direct, ...detours]
  }

  const baseLeftLane = bounds.x + source.width + 52 + (index % 5) * ROUTE_GAP
  const baseRightLane = bounds.x + bounds.width - target.width - 52 - (index % 5) * ROUTE_GAP
  const leftLane = focus ? Math.min(baseLeftLane, focus.x - NODE_CLEARANCE) : baseLeftLane
  const rightLane = focus
    ? Math.max(baseRightLane, focus.x + focus.width + NODE_CLEARANCE)
    : baseRightLane
  const outside = focus
    ? [
        focus.y - 28 - index * ROUTE_GAP,
        focus.y + focus.height + 28 + index * ROUTE_GAP,
        bounds.y - 38 - index * ROUTE_GAP,
        bounds.y + bounds.height + 38 + index * ROUTE_GAP,
      ]
    : [bounds.y - 38 - index * ROUTE_GAP, bounds.y + bounds.height + 38 + index * ROUTE_GAP]
  const startLane = sourceColumn < targetColumn ? leftLane : rightLane
  const endLane = sourceColumn < targetColumn ? rightLane : leftLane
  return outside.map((y) =>
    track([
      start,
      { x: startLane, y: start.y },
      { x: startLane, y },
      { x: endLane, y },
      { x: endLane, y: end.y },
      end,
    ])
  )
}

function assignFocusLanes(
  edges: GraphEdgeInput[],
  nodes: ReadonlyMap<string, Rect>,
  columns: ReadonlyMap<string, number>,
  focusId: string
): Map<string, number> {
  const focus = nodes.get(focusId)
  if (!focus) return new Map()

  const lanes = new Map<string, number>()
  for (const side of [0, 2]) {
    const group = edges
      .filter((edge) => {
        if (edge.source !== focusId && edge.target !== focusId) return false
        const otherId = edge.source === focusId ? edge.target : edge.source
        return columns.get(otherId) === side
      })
      .sort((left, right) => {
        const leftId = left.source === focusId ? left.target : left.source
        const rightId = right.source === focusId ? right.target : right.source
        const leftNode = nodes.get(leftId)
        const rightNode = nodes.get(rightId)
        return (
          (leftNode?.y ?? 0) +
            (leftNode?.height ?? 0) / 2 -
            ((rightNode?.y ?? 0) + (rightNode?.height ?? 0) / 2) || left.id.localeCompare(right.id)
        )
      })
    if (group.length === 0) continue

    const otherRects = group.map(
      (edge) => nodes.get(edge.source === focusId ? edge.target : edge.source)!
    )
    const left =
      side === 0
        ? Math.max(...otherRects.map((node) => node.x + node.width))
        : focus.x + focus.width
    const right = side === 0 ? focus.x : Math.min(...otherRects.map((node) => node.x))
    const available = right - left - NODE_CLEARANCE * 2
    if (available <= 0) continue
    const step = group.length === 1 ? 0 : Math.min(FOCUS_ROUTE_GAP, available / (group.length - 1))
    const center = (left + right) / 2
    group.forEach((edge, index) => {
      lanes.set(edge.id, center + ((group.length - 1) / 2 - index) * step)
    })
  }
  return lanes
}

function trackEndpoints(points: GraphPoint[], index: number): GraphPoint[] {
  const start = points[0]!
  const end = points.at(-1)!
  const firstLane = points[1]!
  const lastLane = points.at(-2)!
  const offset = (Math.floor(index / 2) + 1) * 4 * (index % 2 === 0 ? 1 : -1)
  const startY = start.y + offset
  const endY = end.y + offset
  const stubDistance = 10 + (index + 1) * 2
  const startStub = start.x + Math.sign(firstLane.x - start.x) * stubDistance
  const endStub = end.x + Math.sign(lastLane.x - end.x) * stubDistance
  const middle = points.slice(1, -1).map((point, middleIndex, values) => ({
    x: point.x,
    y: middleIndex === 0 ? startY : middleIndex === values.length - 1 ? endY : point.y,
  }))
  return [
    start,
    { x: startStub, y: start.y },
    { x: startStub, y: startY },
    ...middle,
    { x: endStub, y: endY },
    { x: endStub, y: end.y },
    end,
  ]
}

function routeScore(candidate: GraphPoint[], obstacles: Rect[], used: Segment[]): number {
  const segments = routeSegments(candidate)
  if (
    segments.some((segment) =>
      obstacles.some((rect) => segmentHitsRect(segment, expandRect(rect, NODE_CLEARANCE)))
    )
  )
    return Number.POSITIVE_INFINITY
  if (segments.some((segment) => used.some((existing) => segmentsOverlap(segment, existing))))
    return Number.POSITIVE_INFINITY
  const length = segments.reduce((total, segment) => total + segmentLength(segment), 0)
  const crossings = segments.reduce(
    (total, segment) => total + used.filter((existing) => segmentsCross(segment, existing)).length,
    0
  )
  return length + Math.max(0, segments.length - 1) * 48 + crossings * 420
}

function placeLabel(
  segments: Segment[],
  width: number,
  obstacles: Rect[],
  usedLabels: Rect[]
): GraphPoint {
  for (const segment of [...segments].sort(
    (left, right) => segmentLength(right) - segmentLength(left)
  )) {
    const horizontal = segment.a.y === segment.b.y
    const length = segmentLength(segment)
    const steps = Math.max(2, Math.floor(length / 12))
    const samples = Array.from({ length: steps - 1 }, (_, index) => (index + 1) / steps).sort(
      (left, right) => Math.abs(left - 0.5) - Math.abs(right - 0.5)
    )
    for (const fraction of samples) {
      const point = {
        x: segment.a.x + (segment.b.x - segment.a.x) * fraction,
        y: segment.a.y + (segment.b.y - segment.a.y) * fraction,
      }
      const label = { x: point.x - width / 2, y: point.y - 11, width, height: 22 }
      if (
        (horizontal
          ? Math.min(Math.abs(point.x - segment.a.x), Math.abs(point.x - segment.b.x)) <
            width / 2 + 9
          : Math.min(Math.abs(point.y - segment.a.y), Math.abs(point.y - segment.b.y)) < 13) ||
        obstacles.some((rect) => rectsOverlap(label, expandRect(rect, 6))) ||
        usedLabels.some((rect) => rectsOverlap(label, rect))
      )
        continue
      return point
    }
  }
  const longest = [...segments].sort((left, right) => segmentLength(right) - segmentLength(left))[0]
  return longest
    ? { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 }
    : { x: 0, y: 0 }
}

function handlePoint(rect: Rect, handle: GraphHandleLayout): GraphPoint {
  const ratio = handle.offset / 100
  if (handle.side === "left") return { x: rect.x, y: rect.y + rect.height * ratio }
  if (handle.side === "right") return { x: rect.x + rect.width, y: rect.y + rect.height * ratio }
  if (handle.side === "top") return { x: rect.x + rect.width * ratio, y: rect.y }
  return { x: rect.x + rect.width * ratio, y: rect.y + rect.height }
}

function graphBounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x, y, width: right - x, height: bottom - y }
}

function simplifyRoute(points: GraphPoint[]): GraphPoint[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true
    const previous = points[index - 1]!
    const next = points[index + 1]!
    return !(
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    )
  })
}

function routeSegments(points: GraphPoint[]): Segment[] {
  return points.slice(1).map((point, index) => ({ a: points[index]!, b: point }))
}

function segmentLength(segment: Segment): number {
  return Math.abs(segment.a.x - segment.b.x) + Math.abs(segment.a.y - segment.b.y)
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  }
}

function segmentHitsRect(segment: Segment, rect: Rect): boolean {
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

function segmentsOverlap(left: Segment, right: Segment): boolean {
  if (left.a.x === left.b.x && right.a.x === right.b.x && left.a.x === right.a.x) {
    return overlapLength(left.a.y, left.b.y, right.a.y, right.b.y) > 1
  }
  if (left.a.y === left.b.y && right.a.y === right.b.y && left.a.y === right.a.y) {
    return overlapLength(left.a.x, left.b.x, right.a.x, right.b.x) > 1
  }
  return false
}

function segmentsCross(left: Segment, right: Segment): boolean {
  const horizontal = left.a.y === left.b.y ? left : right.a.y === right.b.y ? right : null
  const vertical = left.a.x === left.b.x ? left : right.a.x === right.b.x ? right : null
  if (!horizontal || !vertical) return false
  return (
    between(vertical.a.x, horizontal.a.x, horizontal.b.x) &&
    between(horizontal.a.y, vertical.a.y, vertical.b.y)
  )
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
