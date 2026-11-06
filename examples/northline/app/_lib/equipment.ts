import { Cpu, Fan, type LucideIcon, Snowflake, Wind } from "lucide-react"

export interface EquipmentIllustration {
  readonly src: string
  /** Fit the whole unit inside the frame instead of filling it. */
  readonly contain: boolean
}

/** The studio illustration for a known unit, so pages can show the equipment, not an icon. */
export function equipmentIllustration(
  equipmentName: string | undefined,
  equipmentType: string | undefined
): EquipmentIllustration | undefined {
  const normalized = equipmentName?.toLowerCase() ?? ""
  if (normalized === "rtu-2") return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized === "rtu-7") return { src: "/illustrations/rtu-7.webp", contain: false }
  if (normalized === "ahu-3") return { src: "/illustrations/ahu-3.webp", contain: false }
  if (normalized.includes("controller")) {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (normalized.includes("chiller"))
    return { src: "/illustrations/chiller-1.webp", contain: false }
  if (normalized.includes("heat pump") || normalized.startsWith("hp-")) {
    return { src: "/illustrations/heat-pump-4.webp", contain: false }
  }
  if (equipmentType === "boiler") return { src: "/illustrations/boiler-2.webp", contain: true }
  return undefined
}

export function equipmentIcon(equipmentType: string | undefined): LucideIcon {
  if (equipmentType === "rooftop_unit" || equipmentType === "heat_pump") return Fan
  if (equipmentType === "air_handler") return Wind
  if (equipmentType === "controller") return Cpu
  return Snowflake
}
