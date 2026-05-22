export const televisionObjectTypeId = "Television"

export const televisionTwinProps = {
  name: "name",
  platform: "platform",
  controlHost: "controlHost",
  manufacturer: "manufacturer",
  modelName: "modelName",
  modelNumber: "modelNumber",
  serialNumber: "serialNumber",
  softwareVersion: "softwareVersion",
  powerState: "powerState",
  activeApp: "activeApp",
  mediaState: "mediaState",
  lastSeenAt: "lastSeenAt",
} as const

export function televisionObjectKeyFromHost(host: string): string {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return `tv-${normalized || "device"}`
}
