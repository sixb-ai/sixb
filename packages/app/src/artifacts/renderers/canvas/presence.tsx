import type { ArtifactLiveUser } from "@sixb/core/artifacts/live"
import { type InternalNode, useStore, ViewportPortal } from "@xyflow/react"
import { Sparkles } from "lucide-react"
import { memo, useCallback } from "react"
import { useLivePresence } from "../../live/presence"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import { NAME_SCALE_VALUE } from "./items"

/** An item's box on the canvas, as React Flow measured it. */
interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * How far down the board view a selection's top must be for its name to show above it: the
 * toolbar, while editing, and a name's height. Higher, the name shows under the selection's top
 * edge, never under the toolbar nor off the view.
 */
export const NAME_CLEARANCE = 96

/** Whether a selection's name goes under its top edge, where the view puts its box now. */
export function nameBelow(box: { readonly y: number }, transform: readonly number[]): boolean {
  const [, panY = 0, zoom = 1] = transform
  return box.y * zoom + panY < NAME_CLEARANCE
}

/**
 * Over the canvas, where the others are: each person's selection outlined in their color, their
 * name above it, or just under its top edge near the top of the view, and each board an Agent
 * turn is changing, its outline shimmering and a badge saying so, kept within the board. Drawn
 * in the canvas's own coordinates, it takes no pointer.
 */
export const PresenceLayer = memo(function PresenceLayer({
  live,
}: {
  readonly live: LiveArtifact
}) {
  const messages = useArtifactMessages().canvas.live
  const { peers, agents } = useLivePresence(live)

  // One outline per item someone selected: the first person who did names it.
  const selected = new Map<string, ArtifactLiveUser>()
  for (const peer of peers) {
    for (const id of peer.selection) if (!selected.has(id)) selected.set(id, peer.user)
  }
  const changing = [...new Set(agents.flatMap((agent) => agent.boards))]
  const boxes = useBoxes([...selected.keys(), ...changing])
  // The selections whose names go under their top edge: read again as the view moves, drawn
  // again only as one of them crosses.
  const below = useStore(
    useCallback(
      (state: { readonly transform: readonly number[] }) =>
        [...boxes]
          .filter(([, box]) => nameBelow(box, state.transform))
          .map(([id]) => id)
          .join("\n"),
      [boxes]
    )
  )

  if (boxes.size === 0) return null
  return (
    <ViewportPortal>
      {changing.map((id) => {
        const box = boxes.get(id)
        return box ? (
          <div
            key={`agent:${id}`}
            data-agent-board={id}
            className="sixb-agent-board pointer-events-none absolute rounded-[12px]"
            style={place(box, 4)}
          >
            {/*
             * The badge's lane: the board's width less its margins, at the badge's scale, so the
             * badge never reaches past the board. Narrow, its words truncate, then leave the icon.
             */}
            <div
              className="@container absolute top-3 right-3 flex origin-top-right justify-end"
              style={{
                width: `calc(${Math.max(box.w - 16, 0)}px / ${NAME_SCALE_VALUE})`,
                transform: `scale(${NAME_SCALE_VALUE})`,
              }}
            >
              <span
                title={messages.agentChanging}
                className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-background/95 px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-primary shadow-[0_1px_2px_rgb(0_0_0/0.08),0_6px_16px_-8px_rgb(0_0_0/0.3)] ring-1 ring-[color-mix(in_oklab,var(--primary)_25%,transparent)] @max-[8rem]:px-1.5"
              >
                <Sparkles
                  className="size-3.5 shrink-0 motion-safe:animate-pulse"
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate @max-[8rem]:sr-only">
                  {messages.agentChanging}
                </span>
              </span>
            </div>
          </div>
        ) : null
      })}
      {[...selected].map(([id, user]) => {
        const box = boxes.get(id)
        return box ? (
          <div
            key={`peer:${id}`}
            data-peer-selection={id}
            className="pointer-events-none absolute rounded-[6px]"
            style={{
              ...place(box, 3),
              boxShadow: `0 0 0 calc(2px * ${NAME_SCALE_VALUE}) ${user.color}`,
            }}
          >
            <span
              data-name={below.split("\n").includes(id) ? "below" : "above"}
              className="absolute left-0 rounded-[4px] px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap text-white data-[name=above]:bottom-full data-[name=above]:mb-1 data-[name=above]:origin-bottom-left data-[name=below]:top-1 data-[name=below]:left-1 data-[name=below]:origin-top-left"
              style={{ backgroundColor: user.color, transform: `scale(${NAME_SCALE_VALUE})` }}
            >
              {user.name}
            </span>
          </div>
        ) : null
      })}
    </ViewportPortal>
  )
})

/** A box drawn `margin` pixels around an item. */
function place(box: Box, margin: number) {
  return {
    transform: `translate(${box.x - margin}px, ${box.y - margin}px)`,
    width: box.w + margin * 2,
    height: box.h + margin * 2,
  }
}

/** The boxes of these items, read again only as one of them moves or changes size. */
function useBoxes(ids: readonly string[]): ReadonlyMap<string, Box> {
  const key = ids.join("\n")
  const select = useCallback(
    (state: { readonly nodeLookup: ReadonlyMap<string, InternalNode> }) => {
      const boxes = new Map<string, Box>()
      for (const id of key ? key.split("\n") : []) {
        const node = state.nodeLookup.get(id)
        const box = node ? boxOf(node) : null
        if (box) boxes.set(id, box)
      }
      return boxes
    },
    [key]
  )
  return useStore(select, sameBoxes)
}

function boxOf(node: InternalNode): Box | null {
  const w = node.measured.width ?? node.width
  const h = node.measured.height ?? node.height
  if (w === undefined || h === undefined) return null
  const { x, y } = node.internals.positionAbsolute
  return { x, y, w, h }
}

function sameBoxes(left: ReadonlyMap<string, Box>, right: ReadonlyMap<string, Box>): boolean {
  if (left.size !== right.size) return false
  for (const [id, box] of left) {
    const other = right.get(id)
    if (
      !other ||
      other.x !== box.x ||
      other.y !== box.y ||
      other.w !== box.w ||
      other.h !== box.h
    ) {
      return false
    }
  }
  return true
}
