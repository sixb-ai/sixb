import {
  type VideoClip,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
  type VideoTarget,
  videoTarget,
} from "@sixb/core/artifacts/live"
import { cn } from "@sixb/ui/lib/utils"
import {
  AudioLines,
  ChevronDown,
  Copy,
  GripVertical,
  Image as ImageIcon,
  Laptop,
  Minus,
  Plus,
  Trash2,
  Type,
  Video,
} from "lucide-react"
import { useRef } from "react"
import { useArtifactMessages } from "../../../messages"
import { formatClock } from "../../../playback"
import { formatSeconds, TextField, textKind } from "./inspector"
import type { MediaTarget } from "./media"
import { useReorder } from "./reorder"
import { SceneThumbnail } from "./scenes"
import { clipName, sceneName, typedText } from "./selection"

// Editing on a phone: what a thumb does well. The chapters in a list, each dragged by its grip to
// reorder, made shorter or longer half a second at a time, and opened to type over its titles or
// delete a clip. The timeline, the transcript and imports wait for a larger screen, as a note at
// the foot says.

/** How much a tap on − or + changes a scene's length. */
const STEP_MS = 500

export interface MobileActions {
  readonly select: (scene: VideoScene) => void
  readonly move: (scene: VideoScene, to: number) => void
  readonly sceneLength: (scene: VideoScene, ms: number) => void
  readonly duplicate: (scene: VideoScene) => void
  readonly remove: (scene: VideoScene) => void
  readonly text: (file: string, text: VideoTarget, words: string) => void
  readonly removeClip: (file: string, clip: VideoClip) => void
}

export function MobileScenes({
  composition,
  timelines,
  target,
  open,
  playing,
  agentScenes,
  actions,
}: {
  readonly composition: VideoComposition
  readonly timelines: ReadonlyMap<string, VideoFileTimeline>
  readonly target: MediaTarget
  readonly open: string | undefined
  readonly playing: string | undefined
  readonly agentScenes: ReadonlySet<string>
  readonly actions: MobileActions
}) {
  const messages = useArtifactMessages().videoEditor
  const list = useRef<HTMLOListElement | null>(null)
  const { scenes } = composition
  const { drag, start } = useReorder({
    items: () => [...(list.current?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? [])],
    axis: "y",
    onMove: (id, _from, to) => {
      const scene = scenes.find((each) => each.id === id)
      if (scene) actions.move(scene, to)
    },
  })

  return (
    <div className="flex flex-col gap-3 px-4 pt-3 pb-6">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {messages.scenes}
      </h3>
      <ol ref={list} className="m-0 flex list-none flex-col gap-2 p-0">
        {scenes.map((scene, index) => {
          const expanded = open === scene.id
          const timeline = timelines.get(scene.src)
          return (
            <li
              key={scene.id}
              data-scene-row={scene.id}
              data-reorder-id={scene.id}
              className={cn(
                "relative overflow-hidden rounded-xl border bg-card transition-opacity",
                expanded ? "border-primary/60" : "border-border",
                drag?.id === scene.id && "opacity-50",
                agentScenes.has(scene.id) && "sixb-agent-board"
              )}
            >
              {drag && drag.slot === index && drag.id !== scene.id ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-primary"
                />
              ) : null}
              <div className="flex items-center gap-2 p-2">
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={messages.reorderHint}
                  className="grid h-12 w-6 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    start(event, scene.id)
                  }}
                >
                  <GripVertical className="size-4" aria-hidden="true" />
                </span>

                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => actions.select(scene)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="relative w-20 shrink-0 overflow-hidden rounded-md">
                    <SceneThumbnail scene={scene} timeline={timeline} target={target} />
                    {playing === scene.id ? (
                      <span className="absolute right-1 bottom-1 size-1.5 rounded-full bg-white" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{sceneName(scene)}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatClock(scene.startMs / 1000)}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      expanded && "rotate-180"
                    )}
                  />
                </button>
              </div>

              <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2">
                <span className="text-[13px] text-muted-foreground">{messages.length}</span>
                <div className="ml-auto flex items-center gap-1">
                  <StepButton
                    label={`${messages.length} −`}
                    disabled={scene.durationMs <= STEP_MS}
                    onClick={() =>
                      actions.sceneLength(scene, Math.max(STEP_MS, scene.durationMs - STEP_MS))
                    }
                  >
                    <Minus />
                  </StepButton>
                  <span className="w-14 text-center text-sm font-medium tabular-nums">
                    {formatSeconds(scene.durationMs)} {messages.seconds}
                  </span>
                  <StepButton
                    label={`${messages.length} +`}
                    onClick={() => actions.sceneLength(scene, scene.durationMs + STEP_MS)}
                  >
                    <Plus />
                  </StepButton>
                </div>
              </div>

              {expanded ? (
                <SceneDetails
                  scene={scene}
                  timeline={timeline}
                  only={scenes.length === 1}
                  actions={actions}
                />
              ) : null}
            </li>
          )
        })}
      </ol>

      <p className="m-0 mt-2 flex items-start gap-2.5 rounded-xl bg-muted/60 p-3 text-[13px] text-muted-foreground">
        <Laptop className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {messages.phoneNote}
      </p>
    </div>
  )
}

function SceneDetails({
  scene,
  timeline,
  only,
  actions,
}: {
  readonly scene: VideoScene
  readonly timeline: VideoFileTimeline | undefined
  readonly only: boolean
  readonly actions: MobileActions
}) {
  const messages = useArtifactMessages().videoEditor
  const texts = timeline?.texts ?? []
  const clips = (timeline?.clips ?? []).filter((clip) => typedText(timeline, clip) === undefined)

  return (
    <div className="flex flex-col gap-4 border-t border-border/70 p-3">
      {texts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {messages.titles}
          </h4>
          {texts.map((text) => (
            <TextField
              key={text.ref}
              label={textKind(text, messages)}
              value={text.text}
              multiline
              hideLabel
              onCommit={(value) => actions.text(scene.src, videoTarget(text), value)}
            />
          ))}
        </section>
      ) : null}

      {clips.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {messages.clips}
          </h4>
          <ul className="m-0 flex list-none flex-col p-0">
            {clips.map((clip) => (
              <li key={clip.ref} className="flex min-h-11 items-center gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
                  {clip.kind === "audio" ? (
                    <AudioLines aria-hidden="true" />
                  ) : clip.kind === "image" ? (
                    <ImageIcon aria-hidden="true" />
                  ) : clip.kind === "video" ? (
                    <Video aria-hidden="true" />
                  ) : (
                    <Type aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{clipName(clip)}</span>
                {clip.durationMs !== undefined ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatSeconds(clip.durationMs)} {messages.seconds}
                  </span>
                ) : null}
                <StepButton
                  label={`${messages.delete} ${clipName(clip)}`}
                  onClick={() => actions.removeClip(scene.src, clip)}
                >
                  <Trash2 />
                </StepButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => actions.duplicate(scene)}
          className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
        >
          <Copy aria-hidden="true" />
          {messages.duplicate}
        </button>
        <button
          type="button"
          disabled={only}
          onClick={() => actions.remove(scene)}
          className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 [&_svg]:size-4"
        >
          <Trash2 aria-hidden="true" />
          {messages.delete}
        </button>
      </div>
    </div>
  )
}

function StepButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-10 place-items-center rounded-full text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
