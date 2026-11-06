import { Cpu, Fan, type LucideIcon, Snowflake, Wind } from "lucide-react"

export interface EquipmentIllustration {
  readonly src: string
  /** Fit the whole unit inside the frame instead of filling it. */
  readonly contain: boolean
}

// One studio illustration per kind of unit, so every page shows the equipment rather than an icon.
// RTU-2 has its own picture; the other rooftop units share RTU-7's.
const illustrationsByType: Readonly<Record<string, EquipmentIllustration>> = {
  rooftop_unit: { src: "/illustrations/rtu-7.webp", contain: false },
  air_handler: { src: "/illustrations/ahu-3.webp", contain: false },
  controller: { src: "/illustrations/building-controller.webp", contain: false },
  chiller: { src: "/illustrations/chiller-1.webp", contain: false },
  heat_pump: { src: "/illustrations/heat-pump-4.webp", contain: false },
  boiler: { src: "/illustrations/boiler-2.webp", contain: true },
}

export function equipmentIllustration(
  equipmentName: string | undefined,
  equipmentType: string | undefined
): EquipmentIllustration | undefined {
  if (equipmentName?.toLowerCase() === "rtu-2") {
    return { src: "/illustrations/rtu-2.webp", contain: false }
  }
  return illustrationsByType[equipmentType ?? ""]
}

/** The icon for a unit with no illustration: a type this example has no picture for. */
export function equipmentIcon(equipmentType: string | undefined): LucideIcon {
  if (equipmentType === "rooftop_unit" || equipmentType === "heat_pump") return Fan
  if (equipmentType === "air_handler") return Wind
  if (equipmentType === "controller") return Cpu
  return Snowflake
}
