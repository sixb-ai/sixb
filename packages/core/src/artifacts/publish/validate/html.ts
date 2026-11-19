import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../../address"
import { decodeHtmlEntities } from "../../html"
import { invalidArtifact } from "../files"
import type { FoundReference } from "../references"

/** The file a web artifact, a deck or a page, renders from. */
export const HTML_ENTRY = "index.html"

/** Where the frame serves the kit and the runtime, beside a web artifact's own files. */
export const FRAME_ASSET_PREFIX = "__sixb/"

/** Refuses a file under `__sixb/`, where the frame serves its own: it would never be served. */
export function refuseFrameAssetPaths(files: readonly ArtifactFile[], what: string): void {
  const reserved = files.find((file) => file.path.startsWith(FRAME_ASSET_PREFIX))
  if (reserved) {
    throw invalidArtifact(
      `'${reserved.path}' is under ${FRAME_ASSET_PREFIX}, where Sixb serves ${what}'s kit and runtime: move it.`
    )
  }
}

/**
 * Where HTML shows or plays a file: each element and the attribute that names the file. A file of
 * another artifact is an `artifact:` address in one of them, which a frame serves as its own.
 */
export const HTML_FILE_ATTRIBUTES = [
  { element: "img", attribute: "src" },
  { element: "video", attribute: "src" },
  { element: "video", attribute: "poster" },
  { element: "audio", attribute: "src" },
  { element: "source", attribute: "src" },
  { element: "track", attribute: "src" },
] as const

/**
 * Reads the `artifact:` addresses a web artifact's HTML uses, to resolve: links (`<a href>`),
 * files it shows or plays from other artifacts (`<img src>`, `<video src>` and its `poster`,
 * `<audio src>`, `<source src>`, `<track src>` for captions), and anything else it shows
 * (`<sixb-embed src>`), a chart, a range, a section, or a slide, which the app draws over the
 * frame. `at` names where each sits, such as a deck's slide, and `file` the HTML file it reads. The
 * first thing that would not render is the refusal.
 */
export function readHtmlReferences(
  rewriter: HTMLRewriter,
  at: () => string,
  file: string = HTML_ENTRY
): { readonly references: FoundReference[]; readonly refusal: () => string | undefined } {
  const references: FoundReference[] = []
  let refused: string | undefined
  rewriter.on("a[href]", {
    element(element) {
      const href = decodeHtmlEntities(element.getAttribute("href") ?? "")
      if (isArtifactAddress(href)) {
        references.push({ address: href.trim(), as: "link", at: at() })
      }
    },
  })

  for (const { element: tag, attribute } of HTML_FILE_ATTRIBUTES) {
    rewriter.on(`${tag}[${attribute}]`, {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute(attribute) ?? "").trim()
        if (!isArtifactAddress(source)) return
        if (!parseArtifactAddress(source)?.path) {
          refused ??= `<${tag} ${attribute}> takes a file from another artifact, and '${source}' names none: show a chart, a range, a section, or a slide with <sixb-embed src="${source}"></sixb-embed>.`
          return
        }
        references.push({ address: source, as: "embed", at: at() })
      },
    })
  }

  rewriter
    .on("sixb-embed", {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute("src") ?? "").trim()
        if (!isArtifactAddress(source)) {
          refused ??= `<sixb-embed> shows another artifact: give it src="artifact:…", such as artifact:art_k3m9q2x7tp#chart=revenue.`
          return
        }
        references.push({ address: source, as: "embed", at: at() })
      },
    })
    .on("iframe[src], object[data], embed[src]", {
      element(element) {
        const source = decodeHtmlEntities(
          element.getAttribute("src") ?? element.getAttribute("data") ?? ""
        ).trim()
        if (isArtifactAddress(source)) {
          refused ??= `${file} frames '${source}': show another artifact with <sixb-embed src="${source}"></sixb-embed>, or a file of one with <img>, <video>, or <audio>.`
        }
      },
    })
  return { references, refusal: () => refused }
}
