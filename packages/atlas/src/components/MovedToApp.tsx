import { useEffect } from "react"
import { type Location, Navigate, useLocation } from "react-router-dom"
import { projectAppUrl } from "../lib/app-url"

/**
 * A page that moved into the project's app. Old links follow it there when Atlas knows the app's
 * address, and land on the Atlas home otherwise. `to` names the page's path in the app; by default
 * it is the same path under `prefix`.
 */
export function MovedToApp({
  prefix = "",
  to,
}: {
  readonly prefix?: string
  readonly to?: (location: Location) => string
}) {
  const location = useLocation()
  const target = projectAppUrl(
    to ? to(location) : `${prefix}${location.pathname}${location.search}`
  )
  useEffect(() => {
    if (target) window.location.replace(target)
  }, [target])
  return target ? null : <Navigate to="/" replace />
}
