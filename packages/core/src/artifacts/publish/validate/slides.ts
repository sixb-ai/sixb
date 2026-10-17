import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../../address"
import { ARTIFACT_LIMITS } from "../../limits"
import type { SlidesOutline } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"

/** The file a deck renders from. */
export const SLIDES_ENTRY = "index.html"

/** Where the frame serves the kit and the runtime, beside a deck's own files. */
export const FRAME_ASSET_PREFIX = "__sixb/"

/**
 * Reads a deck: `index.html` with one `<section class="slide">` per 1280×720 slide, and the files
 * it loads beside it. Each slide's first heading becomes its title in the outline. The `artifact:`
 * addresses it uses are returned with the slide each is on, to resolve: links (`<a href>`), files
 * it shows from other artifacts (`<img src>`), and anything else it shows (`<sixb-embed src>`), a
 * chart, a range, a section, or a slide, which the app draws over the frame.
 */
export async function validateSlides(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: SlidesOutline
  readonly references: readonly FoundReference[]
}> {
  const entry = files.find((file) => file.path === SLIDES_ENTRY)
  if (!entry) {
    throw invalidArtifact(
      `A deck needs '${SLIDES_ENTRY}' with one <section class="slide"> per slide.`
    )
  }
  const reserved = files.find((file) => file.path.startsWith(FRAME_ASSET_PREFIX))
  if (reserved) {
    throw invalidArtifact(
      `'${reserved.path}' is under ${FRAME_ASSET_PREFIX}, where Sixb serves the deck's kit and runtime: move it.`
    )
  }
  const html = await readArtifactText(blobStorage, entry, ARTIFACT_LIMITS.maxDeckBytes)

  const slides: { title: string; heading: boolean }[] = []
  const references: FoundReference[] = []
  let refused: string | undefined
  const at = () => String(Math.max(1, slides.length))
  // The heading being read, if it is the first of the current slide.
  let reading: { title: string; heading: boolean } | null = null
  new HTMLRewriter()
    .on("section", {
      element(element) {
        const classes = (element.getAttribute("class") ?? "").split(/\s+/)
        if (classes.includes("slide")) slides.push({ title: "", heading: false })
      },
    })
    .on("h1, h2, h3", {
      element(element) {
        const slide = slides.at(-1)
        if (!slide || slide.heading) return
        slide.heading = true
        reading = slide
        element.onEndTag(() => {
          reading = null
        })
      },
      text(chunk) {
        if (reading) reading.title += chunk.text
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href") ?? ""
        if (isArtifactAddress(href)) {
          references.push({ address: href.trim(), as: "link", at: at() })
        }
      },
    })
    .on("img[src]", {
      element(element) {
        const source = (element.getAttribute("src") ?? "").trim()
        if (!isArtifactAddress(source)) return
        if (!parseArtifactAddress(source)?.path) {
          refused ??= `An <img> shows a file from another artifact, and '${source}' names none: show a chart, a range, a section, or a slide with <sixb-embed src="${source}"></sixb-embed>.`
          return
        }
        references.push({ address: source, as: "embed", at: at() })
      },
    })
    .on("sixb-embed", {
      element(element) {
        const source = (element.getAttribute("src") ?? "").trim()
        if (!isArtifactAddress(source)) {
          refused ??= `<sixb-embed> shows another artifact: give it src="artifact:…", such as artifact:art_k3m9q2x7tp#chart=revenue.`
          return
        }
        references.push({ address: source, as: "embed", at: at() })
      },
    })
    .on("iframe[src], object[data], embed[src]", {
      element(element) {
        const source = (element.getAttribute("src") ?? element.getAttribute("data") ?? "").trim()
        if (isArtifactAddress(source)) {
          refused ??= `${SLIDES_ENTRY} frames '${source}': show another artifact with <sixb-embed src="${source}"></sixb-embed>, or a file of one with <img>.`
        }
      },
    })
    .transform(html)

  if (refused) throw invalidArtifact(refused)
  if (slides.length === 0) {
    throw invalidArtifact(
      `${SLIDES_ENTRY} has no slides: put each slide in a <section class="slide">.`
    )
  }
  if (slides.length > ARTIFACT_LIMITS.maxSlides) {
    throw invalidArtifact(
      `A deck holds at most ${ARTIFACT_LIMITS.maxSlides} slides; this one has ${slides.length}.`
    )
  }
  return {
    entry: SLIDES_ENTRY,
    outline: {
      kind: "slides",
      slides: slides.map(({ title }) => {
        const plain = decodeEntities(title).replace(/\s+/g, " ").trim()
        return plain ? { title: plain } : {}
      }),
    },
    references,
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/** HTMLRewriter hands over text as written in the HTML, entities included. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match
    const code =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match
  })
}
