import { cn } from "@sixb/ui/lib/utils"
import { equipmentIcon, equipmentIllustration } from "../_lib/equipment"

/**
 * A unit's studio illustration filling its frame, or its type's icon when there is none. The frame
 * is the caller's; `inset` pads the units drawn whole, such as boilers, instead of edge to edge.
 */
export function EquipmentPicture({
  name,
  type,
  inset,
  className,
  iconClassName,
  alt = "",
}: {
  name: string | undefined
  type: string | undefined
  inset: string
  className?: string
  iconClassName: string
  alt?: string
}) {
  const illustration = equipmentIllustration(name, type)
  if (!illustration) {
    const Icon = equipmentIcon(type)
    return <Icon className={iconClassName} strokeWidth={1.4} aria-hidden="true" />
  }
  return (
    <img
      src={illustration.src}
      alt={alt}
      className={cn(
        "size-full",
        illustration.contain ? cn("object-contain", inset) : "object-cover",
        className
      )}
    />
  )
}
