import { type ReactNode, useEffect, useRef, useState } from "react"
import { Modal, PanResponder, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { AttachmentSource } from "../lib/agent/attachments"
import { cardShadow, makeStyles, usePalette } from "../lib/theme"
import { GlassButton } from "./Glass"
import { CameraIcon, CloseIcon, FileUpIcon, PhotoIcon } from "./icons"

const OPTIONS: readonly {
  readonly source: AttachmentSource
  readonly label: string
  readonly icon: (color: string) => ReactNode
}[] = [
  { source: "camera", label: "Camera", icon: (color) => <CameraIcon color={color} /> },
  { source: "library", label: "Photos", icon: (color) => <PhotoIcon color={color} /> },
  { source: "files", label: "Files", icon: (color) => <FileUpIcon color={color} /> },
]

const OPEN_SPRING = { damping: 24, stiffness: 260, mass: 0.9 }
const CLOSE_MS = 200
// A drag past this distance, or a flick faster than this, dismisses the sheet.
const DISMISS_DISTANCE = 90
const DISMISS_VELOCITY = 1

interface AttachSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Called once the sheet is fully gone, since iOS cannot show a picker over a closing sheet. */
  readonly onSelect: (source: AttachmentSource) => void
}

/** A sheet that slides up from the bottom with the places a file can come from. */
export function AttachSheet({ open, onClose, onSelect }: AttachSheetProps) {
  const styles = useStyles()
  const c = usePalette()
  const insets = useSafeAreaInsets()
  const [mounted, setMounted] = useState(open)
  const [height, setHeight] = useState(320)
  const chosen = useRef<AttachmentSource | null>(null)
  const closing = useRef(false)
  const progress = useSharedValue(0)
  const drag = useSharedValue(0)

  useEffect(() => {
    if (!open) return
    chosen.current = null
    closing.current = false
    drag.value = 0
    setMounted(true)
    progress.value = withSpring(1, OPEN_SPRING)
  }, [open, drag, progress])

  const dismiss = (source: AttachmentSource | null) => {
    // A second tap while the sheet slides away must not pick twice or close twice.
    if (closing.current) return
    closing.current = true
    chosen.current = source
    progress.value = withTiming(0, { duration: CLOSE_MS })
    setTimeout(() => {
      setMounted(false)
      onClose()
      // Android has no dismissal callback; its pickers open over a hidden modal anyway.
      if (Platform.OS !== "ios") pickChosen()
    }, CLOSE_MS)
  }

  const pickChosen = () => {
    const source = chosen.current
    chosen.current = null
    if (source) onSelect(source)
  }

  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_, gesture) => {
        drag.value = Math.max(0, gesture.dy)
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
          dismissRef.current(null)
        } else {
          drag.value = withSpring(0, OPEN_SPRING)
        }
      },
      onPanResponderTerminate: () => {
        drag.value = withSpring(0, OPEN_SPRING)
      },
    })
  ).current

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * height + drag.value }],
  }))

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => dismiss(null)}
      onDismiss={pickChosen}
    >
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={StyleSheet.absoluteFill}
          onPress={() => dismiss(null)}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }, sheetStyle]}
        {...pan.panHandlers}
      >
        <View style={styles.handle} />
        <View style={styles.header}>
          <GlassButton accessibilityLabel="Close" onPress={() => dismiss(null)}>
            <CloseIcon color={c.ink} />
          </GlassButton>
          <Text style={styles.title} accessibilityRole="header">
            Add to message
          </Text>
          {/* Balances the close button so the title stays centered. */}
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.options}>
          {OPTIONS.map((option) => (
            <Pressable
              key={option.source}
              accessibilityRole="button"
              onPress={() => dismiss(option.source)}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
            >
              {option.icon(c.ink)}
              <Text style={styles.optionLabel}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      </Animated.View>
    </Modal>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.backdrop },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
      backgroundColor: c.sheet,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 5,
      marginTop: 8,
      borderRadius: 3,
      backgroundColor: c.rule,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 6,
      marginBottom: 18,
    },
    headerSpacer: { width: 40 },
    title: { fontSize: 17, fontWeight: "600", color: c.ink },
    options: { flexDirection: "row", gap: 10 },
    option: {
      flex: 1,
      height: 104,
      gap: 10,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 22,
      backgroundColor: c.sheetTile,
      ...cardShadow,
    },
    optionPressed: { opacity: 0.7 },
    optionLabel: { fontSize: 16, fontWeight: "500", color: c.ink },
  })
)
