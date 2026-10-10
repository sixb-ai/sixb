import { type ReactNode, useState } from "react"
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { makeStyles, usePalette } from "../lib/theme"
import { useKeyboardVisible } from "../lib/use-keyboard-visible"
import { GlassButton } from "./Glass"
import { ChevronLeftIcon } from "./icons"

interface ChatFrameProps {
  readonly header: ReactNode
  readonly composer: ReactNode
  /** Receives the height the floating composer covers, to pad the end of the scrolling body. */
  readonly children: (composerSpace: number) => ReactNode
}

/** A screen whose body scrolls under a floating composer that rides on top of the keyboard. */
export function ChatFrame({ header, composer, children }: ChatFrameProps) {
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()
  const [composerHeight, setComposerHeight] = useState(56)
  // The keyboard covers the home indicator, so the composer drops that inset while it is up.
  const dockBottom = keyboardVisible ? 8 : Math.max(insets.bottom, 16) + 8

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {header}
      {/* The body is what the keyboard shrinks, so a composer pinned to its bottom sits above it. */}
      <View style={styles.body}>
        {children(composerHeight + dockBottom + 16)}
        <View
          style={[styles.dock, { bottom: dockBottom }]}
          onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
        >
          {composer}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

/** A conversation's title bar: back on the left, the title centered. */
export function ChatHeader({
  title,
  backLabel,
  onBack,
}: {
  readonly title: string
  readonly backLabel: string
  readonly onBack: () => void
}) {
  const styles = useStyles()
  const c = usePalette()
  return (
    <View style={styles.header}>
      <GlassButton accessibilityLabel={backLabel} onPress={onBack}>
        <View style={styles.chevron}>
          <ChevronLeftIcon color={c.ink} />
        </View>
      </GlassButton>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.headerSpacer} />
    </View>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: 52,
      paddingTop: 8,
      paddingHorizontal: 16,
    },
    // The chevron's point sits left of its box; nudge it so it reads centered in the circle.
    chevron: { marginLeft: -2 },
    headerSpacer: { width: 40 },
    title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600", color: c.ink },
    body: { flex: 1 },
    dock: { position: "absolute", left: 16, right: 16 },
  })
)
