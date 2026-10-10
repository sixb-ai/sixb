import { parseSixbSignInLink } from "@sixb/client"
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera"
import { useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useRef, useState } from "react"
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { GlassButton } from "../components/Glass"
import { CloseIcon } from "../components/icons"
import { errorMessage } from "../lib/format"
import { night } from "../lib/theme"
import { signInWithCode } from "../lib/workspace"
import { useWorkspace } from "../lib/workspace-context"

// After a failed sign-in, wait before reading codes again, or the same code fails on every frame.
const RETRY_DELAY_MS = 1500

/** Scans the QR code that "Sign in on another device" shows in a signed-in browser. */
export default function ScanScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { open } = useWorkspace()
  const [permission, requestPermission] = useCameraPermissions()
  const [signingIn, setSigningIn] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // The camera reports a code on every frame it sees one; act on one at a time.
  const busy = useRef(false)

  const onScanned = async ({ data }: BarcodeScanningResult) => {
    if (busy.current) return
    const link = parseSixbSignInLink(data)
    if (!link) {
      setMessage("That isn't a Sixb sign-in code.")
      return
    }
    busy.current = true
    setSigningIn(true)
    setMessage(null)
    try {
      // Opening the workspace swaps this screen for Today.
      await open(await signInWithCode(link))
    } catch (cause) {
      setMessage(errorMessage(cause))
      setSigningIn(false)
      setTimeout(() => {
        busy.current = false
      }, RETRY_DELAY_MS)
    }
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={signingIn ? undefined : onScanned}
        />
      ) : null}

      <View
        style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.close}>
          <GlassButton accessibilityLabel="Close" onPress={() => router.back()} scheme="dark">
            <CloseIcon color={night.text} />
          </GlassButton>
        </View>

        <View style={styles.middle}>
          {permission?.granted ? (
            <View style={styles.frame} />
          ) : permission ? (
            <View style={styles.permission}>
              <Text style={styles.title}>Allow the camera</Text>
              <Text style={styles.hint}>Sixb uses the camera only to read the sign-in code.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  permission.canAskAgain ? void requestPermission() : void Linking.openSettings()
                }
                style={styles.button}
              >
                <Text style={styles.buttonText}>
                  {permission.canAskAgain ? "Allow camera" : "Open Settings"}
                </Text>
              </Pressable>
            </View>
          ) : (
            <ActivityIndicator color={night.text} />
          )}
        </View>

        <View style={styles.footer} accessibilityLiveRegion="polite">
          {signingIn ? (
            <View style={styles.status}>
              <ActivityIndicator color={night.text} />
              <Text style={styles.statusText}>Signing in…</Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>Scan the sign-in code</Text>
              <Text style={styles.hint}>
                In Sixb on your computer, open your account menu and choose Sign in on another
                device.
              </Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
            </>
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: night.background },
  overlay: { flex: 1, paddingHorizontal: 24 },
  close: { alignSelf: "flex-start" },
  middle: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: {
    width: 240,
    height: 240,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.9)",
  },
  permission: { alignItems: "center", gap: 10, maxWidth: 300 },
  footer: { gap: 8, minHeight: 110 },
  title: { fontSize: 20, fontWeight: "700", color: night.text, textAlign: "center" },
  hint: { fontSize: 15, lineHeight: 21, color: night.muted, textAlign: "center" },
  message: { fontSize: 15, lineHeight: 20, color: night.error, textAlign: "center" },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  statusText: { fontSize: 17, fontWeight: "600", color: night.text },
  button: {
    marginTop: 8,
    height: 48,
    paddingHorizontal: 24,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: night.text,
  },
  buttonText: { fontSize: 17, fontWeight: "600", color: night.background },
})
