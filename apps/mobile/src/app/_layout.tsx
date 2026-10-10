import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Stack } from "expo-router"
import { useState } from "react"
import { View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { usePalette } from "../lib/theme"
import { useWorkspace, WorkspaceProvider } from "../lib/workspace-context"

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } })
  )
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider>
          <RootStack />
        </WorkspaceProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

// Connect is the only way in until a workspace is open; inside one, it is out of reach. Flipping
// either guard moves the person to whichever side is now open.
function RootStack() {
  const { state } = useWorkspace()
  const palette = usePalette()
  // The splash screen's own background, so opening the app is one unbroken surface.
  if (state.status === "loading")
    return <View style={{ flex: 1, backgroundColor: palette.canvas }} />

  const connected = state.status === "connected"
  return (
    // The screen behind a transition takes the theme's background, so nothing flashes white.
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.canvas } }}
    >
      <Stack.Protected guard={connected}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!connected}>
        <Stack.Screen name="connect" options={{ animation: "fade" }} />
        <Stack.Screen name="scan" options={{ presentation: "fullScreenModal" }} />
      </Stack.Protected>
    </Stack>
  )
}
