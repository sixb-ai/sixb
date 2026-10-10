import { Stack } from "expo-router"
import { usePalette } from "../../lib/theme"
import { useWorkspace } from "../../lib/workspace-context"

export default function WorkspaceLayout() {
  const c = usePalette()
  const { state } = useWorkspace()
  // Screens here read the open workspace; render nothing while leaving one.
  if (state.status !== "connected") return null
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.canvas } }} />
  )
}
