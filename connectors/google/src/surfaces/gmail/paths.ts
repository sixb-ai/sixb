import { pathSegment } from "../../http"

export function gmailUserPath(userId: string, suffix = ""): string {
  return `users/${pathSegment(userId, "userId")}${suffix}`
}

export function gmailCollectionPath(userId: string, collection: string, suffix = ""): string {
  return gmailUserPath(userId, `/${collection}${suffix}`)
}

export function gmailResourcePath(
  userId: string,
  collection: string,
  id: string,
  idField: string,
  suffix = ""
): string {
  return gmailCollectionPath(userId, collection, `/${pathSegment(id, idField)}${suffix}`)
}
