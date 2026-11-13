import { uploadFile } from "@sixb/client"
import { ARTIFACT_LIMITS } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { useLocale } from "@sixb/ui/lib/i18n"
import { useCallback } from "react"
import { formatFileSize } from "../file-size"
import type { LiveArtifact } from "../live/session"
import { useArtifactMessages } from "../messages"
import type { ArtifactVersion } from "../queries"
import { imagePath } from "../renderers/canvas/board-editor"

/**
 * Stores a picture a person adds to a document as a file of it, beside its entry under its own
 * name made safe, as a board's pictures are, and says where the document points to it. Throws,
 * saying why, when it cannot: too large, or no live document to add it to.
 */
export function useImageUpload(
  live: LiveArtifact | null,
  version: ArtifactVersion
): (file: File) => Promise<{ readonly src: string; readonly alt: string }> {
  const messages = useArtifactMessages()
  const locale = useLocale()
  return useCallback(
    async (file: File) => {
      if (!live) throw new Error(messages.editor.imageFailed)
      if (file.size > ARTIFACT_LIMITS.maxFileBytes) {
        throw new Error(
          messages.editor.imageTooLarge(
            formatFileSize(ARTIFACT_LIMITS.maxFileBytes, locale, messages.files)
          )
        )
      }
      const path = imagePath(version.entry, file.name)
      const ref = await uploadFile(file, { fileName: path.split("/").at(-1) ?? path })
      live.doc.getMap(LIVE_FILES).set(path, { ...ref })
      return { src: path, alt: file.name.replace(/\.[^.]*$/, "") }
    },
    [live, version.entry, messages, locale]
  )
}
