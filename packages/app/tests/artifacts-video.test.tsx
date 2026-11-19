import { describe, expect, test } from "bun:test"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { versionSummary } from "../src/artifacts/card-details"
import { ArtifactPreview } from "../src/artifacts/card-preview"
import { en, fr } from "../src/artifacts/messages"
import { VideoRenderer } from "../src/artifacts/renderers/video/renderer"
import { artifactVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

installDom(["document", "navigator", "HTMLElement", "Node", "Element"])

// A video before it plays: its screen, and its scenes as chapters with their times.

const FILM = artifactVersion({
  artifactId: "art_v1de0f17m0",
  title: "Launch film",
  entry: "index.html",
  files: textFiles({ "index.html": "<div></div>" }),
  outline: {
    kind: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 7000,
    scenes: [
      { id: "intro", label: "Opening", startMs: 0, durationMs: 2000, renderKey: "a" },
      { id: "demo", startMs: 2000, durationMs: 3000, renderKey: "b" },
      { id: "outro", label: "Thanks", startMs: 5500, durationMs: 1500, renderKey: "c" },
    ],
  },
})

function Wrap({ locale, children }: { readonly locale?: string; readonly children: ReactNode }) {
  const queries = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  return (
    <QueryClientProvider client={queries}>
      <LocaleProvider {...(locale ? { locale } : {})}>{children}</LocaleProvider>
    </QueryClientProvider>
  )
}

const chapters = (container: HTMLElement) =>
  within(container)
    .getAllByRole("listitem")
    .map((item) => item.textContent)

describe("a video, before it plays", () => {
  test("shows its scenes as chapters, each at its time, and says playback is coming", () => {
    const view = render(
      <Wrap>
        <VideoRenderer version={FILM} />
      </Wrap>
    )

    expect(view.getByRole("img", { name: "Video Launch film" }).textContent).toContain(
      "Playback is coming soon"
    )
    expect(view.getByText("0:07")).toBeTruthy()
    expect(chapters(view.container)).toEqual([
      "10:00Opening2 s",
      "20:02demo3 s",
      "30:05Thanks1.5 s",
    ])
    expect(view.container.querySelector("[aria-current]")).toBeNull()
  })

  // Guard proof: return undefined from markedScene in renderer.tsx; no scene is marked.
  test("marks the scene an address names, or the one playing at its instant", () => {
    const marked = (part: string) => {
      const view = render(
        <Wrap>
          <VideoRenderer version={FILM} part={part} />
        </Wrap>
      )
      const current = view.container.querySelector("[aria-current='true']")?.textContent
      view.unmount()
      return current
    }

    expect(marked("demo")).toBe("20:02demo3 s")
    expect(marked("t=6")).toBe("30:05Thanks1.5 s")
    // Between two scenes, and past the end, nothing plays.
    expect(marked("t=5.2")).toBeUndefined()
    expect(marked("credits")).toBeUndefined()
  })

  test("speaks French", () => {
    const view = render(
      <Wrap locale="fr">
        <VideoRenderer version={FILM} />
      </Wrap>
    )
    expect(view.getByRole("img", { name: "Vidéo Launch film" }).textContent).toContain(
      "Bientôt lisible ici"
    )
    expect(view.getByRole("region", { name: "Scènes" })).toBeTruthy()
    expect(chapters(view.container)[2]).toBe("30:05Thanks1,5 s")
  })

  test("is a dark screen on its card, its scenes along its length", () => {
    const view = render(
      <Wrap>
        <ArtifactPreview version={FILM} kind="video" loading={false} />
      </Wrap>
    )
    const scenes = [...view.container.querySelectorAll<HTMLElement>("[style*='left']")]
    expect(scenes.map((scene) => [scene.style.left, scene.style.width])).toEqual([
      ["0%", `${(2 / 7) * 100}%`],
      [`${(2 / 7) * 100}%`, `${(3 / 7) * 100}%`],
      [`${(5.5 / 7) * 100}%`, `${(1.5 / 7) * 100}%`],
    ])
  })
})

describe("a video in words", () => {
  test("is summed up by its length and its scenes", () => {
    expect(versionSummary(FILM, en, "en")).toBe("Video · 0:07 · 3 scenes")
    expect(versionSummary(FILM, fr, "fr")).toBe("Vidéo · 0:07 · 3 scènes")
  })

  test("is counted and missed in the gallery, in the feminine in French", () => {
    expect(en.gallery.count(1, "video")).toBe("1 video")
    expect(en.gallery.emptyKind("video")).toBe("No videos yet")
    expect(fr.gallery.count(2, "video")).toBe("2 vidéos")
    expect(fr.gallery.emptyKind("video")).toBe("Aucune vidéo pour l’instant")
  })
})
