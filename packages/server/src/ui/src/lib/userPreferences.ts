const favoritesPrefix = "pario:favorites:"
const recentAssetsPrefix = "pario:recent-assets:"

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

function favoritesKey(projectName: string): string {
  return `${favoritesPrefix}${projectName}`
}

function recentsKey(projectName: string): string {
  return `${recentAssetsPrefix}${projectName}`
}

export function getFavoriteObjectIds(projectName: string): string[] {
  return readStringArray(favoritesKey(projectName))
}

export function setFavoriteObjectIds(projectName: string, ids: string[]) {
  writeStringArray(favoritesKey(projectName), ids)
}

export function toggleFavoriteObject(projectName: string, objectId: string): string[] {
  const existing = getFavoriteObjectIds(projectName)
  const next = existing.includes(objectId)
    ? existing.filter((id) => id !== objectId)
    : [objectId, ...existing].slice(0, 12)
  setFavoriteObjectIds(projectName, next)
  return next
}

export function trackRecentObject(projectName: string, objectId: string) {
  const existing = readStringArray(recentsKey(projectName))
  const next = [objectId, ...existing.filter((id) => id !== objectId)].slice(0, 20)
  writeStringArray(recentsKey(projectName), next)
}

export function getRecentObjectIds(projectName: string, limit = 5): string[] {
  return readStringArray(recentsKey(projectName)).slice(0, limit)
}

const viewStyleKey = "pario:asset-view-style"
const collectionViewStylePrefix = "pario:collection-view-style:"

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

export function getObjectViewStyle(): "cards" | "table" | "graph" {
  return readViewStyle(viewStyleKey, ["cards", "table", "graph"], "cards")
}

export function setObjectViewStyle(style: "cards" | "table" | "graph") {
  writeViewStyle(viewStyleKey, style)
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
