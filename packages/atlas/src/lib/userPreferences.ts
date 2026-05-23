const recentAssetsPrefix = "sixb:recent-assets:"

function readStringArray(key: string): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}

function writeStringArray(key: string, value: string[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage errors (private mode / quota).
  }
}

function recentsKey(projectName: string): string {
  return `${recentAssetsPrefix}${projectName}`
}

export function trackRecentObject(projectName: string, objectId: string) {
  const existing = readStringArray(recentsKey(projectName))
  const next = [objectId, ...existing.filter((id) => id !== objectId)].slice(0, 20)
  writeStringArray(recentsKey(projectName), next)
}

export function getRecentObjectIds(projectName: string, limit = 5): string[] {
  return readStringArray(recentsKey(projectName)).slice(0, limit)
}

const viewStyleKey = "sixb:asset-view-style"
const objectSortKey = "sixb:object-sort"
const collectionViewStylePrefix = "sixb:collection-view-style:"

export type ObjectSortPreference = "primaryId" | "updatedAt"

function readViewStyle<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback
  try {
    const value = window.localStorage.getItem(key)
    return allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function writeViewStyle(key: string, style: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, style)
  } catch {
    // Ignore storage errors.
  }
}

export function getObjectViewStyle(): "cards" | "table" {
  return readViewStyle(viewStyleKey, ["cards", "table"], "cards")
}

export function setObjectViewStyle(style: "cards" | "table") {
  writeViewStyle(viewStyleKey, style)
}

export function getObjectSortPreference(): ObjectSortPreference {
  return readViewStyle(objectSortKey, ["primaryId", "updatedAt"], "primaryId")
}

export function setObjectSortPreference(sort: ObjectSortPreference) {
  writeViewStyle(objectSortKey, sort)
}

export function getCollectionViewStyle<T extends string>(
  collection: string,
  allowed: readonly T[],
  fallback: T
): T {
  return readViewStyle(`${collectionViewStylePrefix}${collection}`, allowed, fallback)
}

export function setCollectionViewStyle(collection: string, style: string) {
  writeViewStyle(`${collectionViewStylePrefix}${collection}`, style)
}
