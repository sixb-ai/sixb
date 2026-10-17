import type { GetArtifactResponse } from "@sixb/client"
import { File, FileText, Presentation, Table2 } from "lucide-react"

export type ArtifactKindName = GetArtifactResponse["artifact"]["kind"]

const KIND_ICONS: Record<ArtifactKindName, typeof FileText> = {
  document: FileText,
  sheet: Table2,
  slides: Presentation,
  file: File,
}

/** The icon that stands for an artifact's kind wherever artifacts are listed. */
export function ArtifactKindIcon({
  kind,
  className,
}: {
  readonly kind: ArtifactKindName
  readonly className?: string
}) {
  const Icon = KIND_ICONS[kind]
  return <Icon className={className} aria-hidden="true" />
}
