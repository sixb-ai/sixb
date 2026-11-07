import { useCallback } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { historyIndex, parentPath } from "./routes"

/**
 * Back, as a phone's navigation bar does it: one step back through the app's history, else, on a
 * screen opened directly, up to the screen above it in place of this one.
 */
export function useBack(): () => void {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return useCallback(() => {
    if (historyIndex() > 0) navigate(-1)
    else navigate(parentPath(pathname), { replace: true })
  }, [navigate, pathname])
}
