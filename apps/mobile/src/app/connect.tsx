import { parseSixbSignInLink } from "@sixb/client"
import { useLocalSearchParams, useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import Animated, { FadeInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg"
import { Glass } from "../components/Glass"
import { QrIcon } from "../components/icons"
import { SixbWordmark } from "../components/SixbWordmark"
import { errorMessage } from "../lib/format"
import { night } from "../lib/theme"
import { useKeyboardVisible } from "../lib/use-keyboard-visible"
import { probeWorkspace, signInWithBrowser, signInWithCode } from "../lib/workspace"
import { normalizeWorkspaceAddress } from "../lib/workspace-address"
import { useWorkspace } from "../lib/workspace-context"

type Phase = "idle" | "checking" | "signing-in" | "using-code"

/** Scanning a code is the quick way in; typing the address is the other. */
type Method = "code" | "address"

const BUSY_LABEL: Record<Exclude<Phase, "idle">, string> = {
  checking: "Connecting…",
  "signing-in": "Finish signing in…",
  "using-code": "Signing in…",
}

export default function ConnectScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const keyboardVisible = useKeyboardVisible()
  const { state, open } = useWorkspace()
  const previous = state.status === "disconnected" ? state : null
  const [address, setAddress] = useState(() =>
    previous?.address ? previous.address.replace(/^https:\/\//, "") : ""
  )
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const message = error ?? previous?.notice ?? null
  // Back from an ended session, offer the same address again.
  const [method, setMethod] = useState<Method>(previous?.address ? "address" : "code")
  const [switched, setSwitched] = useState(false)
  const busy = phase !== "idle"

  const switchTo = (next: Method) => {
    setError(null)
    setSwitched(true)
    setMethod(next)
  }

  // A `sixb://connect?api=…&code=…` link, opened from the Camera app or another app, signs in
  // straight away: it is the QR code from "Sign in on another device".
  const params = useLocalSearchParams<{ api?: string; code?: string }>()
  const usedCode = useRef<string | null>(null)
  useEffect(() => {
    if (!params.api || !params.code || usedCode.current === params.code) return
    usedCode.current = params.code
    const link = parseSixbSignInLink(
      `sixb://connect?${new URLSearchParams({ api: params.api, code: params.code })}`
    )
    if (!link) {
      setError("That sign-in link isn't valid.")
      return
    }
    setError(null)
    setPhase("using-code")
    signInWithCode(link)
      .then(open)
      .catch((cause: unknown) => {
        setError(errorMessage(cause))
        setPhase("idle")
      })
  }, [open, params.api, params.code])

  const submit = async () => {
    if (phase !== "idle") return
    setError(null)
    try {
      const baseUrl = normalizeWorkspaceAddress(address)
      setPhase("checking")
      const workspace = await probeWorkspace(baseUrl)
      if (workspace.signIn) {
        setPhase("signing-in")
        if (!(await signInWithBrowser(workspace))) {
          setPhase("idle")
          return
        }
      }
      // Opening the workspace swaps this screen for Today.
      await open(workspace)
    } catch (cause) {
      setError(errorMessage(cause))
      setPhase("idle")
    }
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <Svg style={styles.glow} width={670} height={640} aria-hidden>
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.1} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={335} cy={320} rx={335} ry={320} fill="url(#glow)" />
      </Svg>

      {/* The avoiding view owns its bottom padding (the keyboard's height), so the screen's own
          spacing lives on the view inside it. The keyboard covers the home indicator. */}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.content,
            {
              paddingTop: insets.top + 24,
              paddingBottom: keyboardVisible ? 16 : Math.max(insets.bottom, 16) + 24,
            },
          ]}
        >
          <SixbWordmark color={night.text} />

          <View style={styles.hero}>
            <Text style={styles.headline} accessibilityRole="header">
              Your company,{"\n"}
              <Text style={styles.headlineMuted}>in your pocket.</Text>
            </Text>
            <Text style={styles.lede}>See what needs you. Decide in a tap.</Text>
          </View>

          <View style={styles.form}>
            {method === "address" ? (
              <Animated.View key="address" entering={SWAP} style={styles.form}>
                <Glass scheme="dark" style={styles.field}>
                  <TextInput
                    accessibilityLabel="Workspace address"
                    style={styles.input}
                    value={address}
                    onChangeText={setAddress}
                    placeholder="Workspace address"
                    placeholderTextColor={night.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="url"
                    autoFocus={switched}
                    keyboardAppearance="dark"
                    keyboardType="url"
                    textContentType="URL"
                    returnKeyType="go"
                    editable={!busy}
                    onSubmitEditing={submit}
                  />
                </Glass>
                {message ? <Message text={message} /> : null}
                <PrimaryButton
                  label={busy ? BUSY_LABEL[phase] : "Continue"}
                  busy={busy}
                  onPress={submit}
                />
                <TextButton
                  label="Scan a code instead"
                  disabled={busy}
                  onPress={() => switchTo("code")}
                />
              </Animated.View>
            ) : (
              <Animated.View key="code" entering={SWAP} style={styles.form}>
                {message ? <Message text={message} /> : null}
                <PrimaryButton
                  label={busy ? BUSY_LABEL[phase] : "Scan sign-in code"}
                  icon={<QrIcon color={night.background} />}
                  busy={busy}
                  onPress={() => router.push("/scan")}
                />
                <TextButton
                  label="Enter a workspace address"
                  disabled={busy}
                  onPress={() => switchTo("address")}
                />
              </Animated.View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

// Switching methods fades the new controls in, rising slightly into place.
const SWAP = FadeInDown.duration(220)

function PrimaryButton({
  label,
  icon,
  busy,
  onPress,
}: {
  readonly label: string
  readonly icon?: ReactNode
  readonly busy: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      {busy ? <ActivityIndicator color={night.background} /> : icon}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

function TextButton({
  label,
  disabled,
  onPress,
}: {
  readonly label: string
  readonly disabled: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, pressed && styles.buttonPressed]}
    >
      <Text style={styles.textButtonLabel}>{label}</Text>
    </Pressable>
  )
}

function Message({ text }: { readonly text: string }) {
  return (
    <Text style={styles.message} accessibilityLiveRegion="polite">
      {text}
    </Text>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: night.background, overflow: "hidden" },
  glow: { position: "absolute", left: -140, top: -300 },
  fill: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24 },
  hero: { flex: 1, justifyContent: "center", paddingBottom: 40 },
  headline: {
    fontSize: 52,
    lineHeight: 53,
    fontWeight: "700",
    letterSpacing: -2.3,
    color: night.text,
  },
  headlineMuted: { color: night.faint },
  lede: { marginTop: 22, maxWidth: 300, fontSize: 19, lineHeight: 27, color: night.muted },
  form: { gap: 12 },
  // The address field is glass over the dark welcome screen; the input inside is bare.
  field: { height: 56, borderRadius: 28 },
  input: { flex: 1, paddingHorizontal: 20, color: night.text, fontSize: 17 },
  message: {
    paddingHorizontal: 4,
    fontSize: 15,
    lineHeight: 20,
    color: night.error,
    textAlign: "center",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 56,
    borderRadius: 28,
    backgroundColor: night.text,
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { fontSize: 17, fontWeight: "600", color: night.background },
  textButton: { height: 44, alignItems: "center", justifyContent: "center" },
  textButtonLabel: { fontSize: 15, fontWeight: "500", color: night.muted },
})
