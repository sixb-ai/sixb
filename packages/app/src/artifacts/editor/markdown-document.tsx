import { uploadFile } from "@sixb/client"
import { ARTIFACT_LIMITS } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { useLocale } from "@sixb/ui/lib/i18n"
import { useCallback, useEffect, useRef } from "react"
import * as Y from "yjs"
import { formatFileSize } from "../file-size"
import { useLiveArtifactState, useViewerLiveArtifact } from "../live/hooks"
import { useArtifactMessages } from "../messages"
import { type ArtifactVersion, versionImageSource } from "../queries"
import { imagePath } from "../renderers/canvas/board-editor"
import { DocumentRenderer } from "../renderers/document"
import { useArtifactThemeAttributes } from "../theme"
import { DocumentEditor } from "./document-editor"

/**
 * A Markdown document's body: once the live document holds its blocks, the editor, which
 * everyone who may change it types into as it is shown; until then, and for an older version, the
 * document page.
 */
export function MarkdownDocument({
  version,
  latestVersion,
  part,
}: {
  readonly version: ArtifactVersion
  readonly latestVersion: number
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const theme = useArtifactThemeAttributes(version)
  const live = useViewerLiveArtifact()
  const state = useLiveArtifactState(live)
  // An image added since the version was read shows from the reader's own copy until one holds it.
  const previews = useRef(new Map<string, string>())
  useEffect(() => {
    const kept = previews.current
    return () => {
      for (const url of kept.values()) URL.revokeObjectURL(url)
    }
  }, [])
  const imageSource = useCallback(
    (src: string) =>
      previews.current.get(src) ?? versionImageSource(version, src)?.inlineUrl ?? null,
    [version]
  )
  const uploadImage = useCallback(
    async (file: File) => {
      if (!live) throw new Error(messages.editor.imageFailed)
      if (file.size > ARTIFACT_LIMITS.maxFileBytes) {
        throw new Error(
          messages.editor.imageTooLarge(
            formatFileSize(ARTIFACT_LIMITS.maxFileBytes, locale, messages.files)
          )
        )
      }
      // Beside the document, under its own name made safe, as a board's pictures are.
      const path = imagePath(version.entry, file.name)
      const ref = await uploadFile(file, { fileName: path.split("/").at(-1) ?? path })
      previews.current.set(path, URL.createObjectURL(file))
      live.doc.getMap(LIVE_FILES).set(path, { ...ref })
      return { src: path, alt: file.name.replace(/\.[^.]*$/, "") }
    },
    [live, version.entry, messages, locale]
  )

  const fragment =
    live && state.synced && version.version === latestVersion
      ? live.doc.getMap(LIVE_FILES).get(version.entry)
      : null
  if (live && fragment instanceof Y.XmlFragment) {
    return (
      <DocumentEditor
        fragment={fragment}
        awareness={live.awareness}
        editable={state.access === "edit" && !state.left}
        imageSource={imageSource}
        messages={messages.editor}
        theme={theme}
        {...(part ? { part } : {})}
        {...(state.access === "edit" ? { uploadImage } : {})}
      />
    )
  }
  return <DocumentRenderer version={version} latestVersion={latestVersion} part={part} />
}
