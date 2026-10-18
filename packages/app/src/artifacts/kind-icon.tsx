import type { GetArtifactResponse } from "@sixb/client"
import { cn } from "@sixb/ui/lib/utils"
import { AppWindow, File, FileText, Presentation, Shapes, Table2 } from "lucide-react"

export type ArtifactKindName = GetArtifactResponse["artifact"]["kind"]

const KIND_ICONS: Record<ArtifactKindName, typeof FileText> = {
  document: FileText,
  sheet: Table2,
  slides: Presentation,
  page: AppWindow,
  canvas: Shapes,
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

/** An artifact's kind as a small neutral tile, as a header leads with it. */
export function ArtifactKindTile({
  kind,
  label,
  className,
}: {
  readonly kind: ArtifactKindName
  /** The kind's name, for assistive technology and on hover. */
  readonly label: string
  readonly className?: string
}) {
  const Icon = KIND_ICONS[kind]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-foreground/75 shadow-[0_1px_1px_rgb(0_0_0/0.04)] ring-1 ring-border/80 ring-inset [&_svg]:size-[15px] [&_svg]:stroke-[1.75]",
        className
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  )
}
