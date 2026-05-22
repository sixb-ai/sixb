export const DEFAULT_ROKU_TIMEOUT_MS = 5000
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000
export const SSDP_ADDRESS = "239.255.255.250"
export const SSDP_PORT = 1900

export const rokuKeys = [
  "Home",
  "Rev",
  "Fwd",
  "Play",
  "Select",
  "Left",
  "Right",
  "Down",
  "Up",
  "Back",
  "InstantReplay",
  "Info",
  "Backspace",
  "Search",
  "Enter",
  "VolumeDown",
  "VolumeMute",
  "VolumeUp",
  "PowerOff",
  "Power",
] as const

export type RokuKey = (typeof rokuKeys)[number]

export interface RokuDeviceInfo {
  friendlyName: string
  modelName: string
  modelNumber: string
  serialNumber: string
  softwareVersion: string
  softwareBuild: string
  vendorName: string
  isTv: boolean
  powerMode: string
}

export interface RokuMediaPlayerState {
  state: string
  isLive: boolean
  error: boolean
}

export interface RokuApp {
  id: string
  name: string
  type?: string
  version?: string
}

export interface RokuActiveApp extends RokuApp {
  kind: "app" | "screensaver"
}

export interface RokuDiscoveryOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DiscoveredRokuDevice {
  host: string
  location: string
  usn?: string
  server?: string
}
