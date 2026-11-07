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

/** A unit's picture in a small rounded tile, as list rows show it; the caller sets the size. */
export function EquipmentThumb({
  name,
  type,
  className,
}: {
  name: string | undefined
  type: string | undefined
  className: string
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-muted",
        className
      )}
    >
      <EquipmentPicture
        name={name}
        type={type}
        inset="p-[8%]"
        iconClassName="size-[45%] text-foreground/55"
      />
    </span>
  )
}
