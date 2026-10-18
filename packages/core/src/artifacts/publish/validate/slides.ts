import type { ArtifactFile } from "../../../storage/artifacts/types"
import { decodeHtmlEntities } from "../../html"
import { ARTIFACT_LIMITS } from "../../limits"
import type { SlidesOutline } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { HTML_ENTRY, readHtmlReferences, refuseFrameAssetPaths } from "./html"

/**
 * Reads a deck: `index.html` with one `<section class="slide">` per 1280×720 slide, and the files
 * it loads beside it. Each slide's first heading becomes its title in the outline. The `artifact:`
 * addresses it uses are returned with the slide each is on, to resolve.
 */
export async function validateSlides(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: SlidesOutline
  readonly references: readonly FoundReference[]
}> {
  const entry = files.find((file) => file.path === HTML_ENTRY)
  if (!entry) {
    throw invalidArtifact(
      `A deck needs '${HTML_ENTRY}' with one <section class="slide"> per slide.`
    )
  }
  refuseFrameAssetPaths(files, "the deck")
  const html = await readArtifactText(blobStorage, entry, ARTIFACT_LIMITS.maxDeckBytes)

  const slides: { title: string; heading: boolean }[] = []
  const at = () => String(Math.max(1, slides.length))
  // The heading being read, if it is the first of the current slide.
  let reading: { title: string; heading: boolean } | null = null
  const rewriter = new HTMLRewriter()
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
  const { references, refusal } = readHtmlReferences(rewriter, at)
  rewriter.transform(html)

  const refused = refusal()
  if (refused) throw invalidArtifact(refused)
  if (slides.length === 0) {
    throw invalidArtifact(
      `${HTML_ENTRY} has no slides: put each slide in a <section class="slide">.`
    )
  }
  if (slides.length > ARTIFACT_LIMITS.maxSlides) {
    throw invalidArtifact(
      `A deck holds at most ${ARTIFACT_LIMITS.maxSlides} slides; this one has ${slides.length}.`
    )
  }
  return {
    entry: HTML_ENTRY,
    outline: {
      kind: "slides",
      slides: slides.map(({ title }) => {
        const plain = decodeHtmlEntities(title).replace(/\s+/g, " ").trim()
        return plain ? { title: plain } : {}
      }),
    },
    references,
  }
}
