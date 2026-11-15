import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { useCallback, useEffect, useRef } from "react"
import * as Y from "yjs"
import { useLiveArtifactState, useViewerLiveArtifact } from "../live/hooks"
import { useArtifactMessages } from "../messages"
import { type ArtifactVersion, versionImageSource } from "../queries"
import { DocumentRenderer } from "../renderers/document"
import { useArtifactThemeAttributes } from "../theme"
import { DocumentEditor } from "./document-editor"
import { useImageUpload } from "./upload"

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
  const upload = useImageUpload(live, version)
  const uploadImage = useCallback(
    async (file: File) => {
      const added = await upload(file)
      previews.current.set(added.src, URL.createObjectURL(file))
      return added
    },
    [upload]
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
