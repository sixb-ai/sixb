import { ActivityIndicator, StyleSheet, Text, View } from "react-native"
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated"
import type { NormalizedPart, NormalizedTool } from "../lib/agent/types"
import { makeStyles, usePalette } from "../lib/theme"
import { MessageFile } from "./attachments"
import { AlertIcon, CheckIcon, FileIcon } from "./icons"
import { MarkdownText } from "./MarkdownText"

// A sent message rises from the composer; reply parts fade in where they land.
export const RISE = FadeInDown.springify().damping(20).stiffness(190)
const APPEAR = FadeIn.duration(260)

/** A message you sent: dark on light, or light on dark, at the right edge. */
export function UserBubble({ text }: { readonly text: string }) {
  const styles = useStyles()
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{text}</Text>
      </View>
    </View>
  )
}

/**
 * An assistant turn: its text as markdown, each tool call as one quiet line, files it made as
 * images or chips. Reasoning stays hidden. `message` is the saved message the parts came from.
 */
export function AssistantParts({
  parts,
  message,
  animated,
}: {
  readonly parts: readonly NormalizedPart[]
  readonly message?: { readonly threadId: string; readonly id: string }
  readonly animated?: boolean
}) {
  const styles = useStyles()
  return (
    <View style={styles.assistant}>
      {parts.map((part, index) =>
        part.kind === "reasoning" ? null : (
          <Animated.View key={index} entering={animated ? APPEAR : undefined}>
            <AssistantPart part={part} message={message} />
          </Animated.View>
        )
      )}
    </View>
  )
}

function AssistantPart({
  part,
  message,
}: {
  readonly part: NormalizedPart
  readonly message?: { readonly threadId: string; readonly id: string }
}) {
  const styles = useStyles()
  const c = usePalette()
  switch (part.kind) {
    case "text":
      return <MarkdownText value={part.text} />
    case "tool":
      return <ToolLine tool={part.tool} />
    case "file":
      if (message) {
        return <MessageFile message={message} fileRef={part.fileRef} partIndex={part.partIndex} />
      }
      return (
        <View style={styles.statusLine}>
          <FileIcon color={c.muted} />
          <Text style={styles.statusText} numberOfLines={1}>
            {part.fileRef.fileName ?? "File"}
          </Text>
        </View>
      )
    default:
      return null
  }
}

function ToolLine({ tool }: { readonly tool: NormalizedTool }) {
  const styles = useStyles()
  const c = usePalette()
  const name = tool.toolName.replace(/[_-]+/g, " ").trim()
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  return (
    <View style={styles.statusLine}>
      {running ? (
        <ActivityIndicator size="small" color={c.muted} style={styles.statusSpinner} />
      ) : failed ? (
        <AlertIcon color={c.danger} />
      ) : (
        <CheckIcon color={c.muted} />
      )}
      <Text style={styles.statusText} numberOfLines={1}>
        {running ? `Using ${name}…` : failed ? `${name} failed` : `Used ${name}`}
      </Text>
    </View>
  )
}

export function Thinking() {
  const styles = useStyles()
  const c = usePalette()
  return (
    <Animated.View
      entering={FadeIn.delay(150).duration(220)}
      exiting={FadeOut.duration(120)}
      style={[styles.statusLine, styles.standalone]}
    >
      <ActivityIndicator size="small" color={c.muted} style={styles.statusSpinner} />
      <Text style={styles.statusText}>Thinking…</Text>
    </Animated.View>
  )
}

export function ErrorNote({ message }: { readonly message: string }) {
  const styles = useStyles()
  const c = usePalette()
  return (
    <Animated.View entering={APPEAR} style={[styles.statusLine, styles.standalone]}>
      <AlertIcon color={c.danger} />
      <Text style={[styles.statusText, styles.errorText]}>{message}</Text>
    </Animated.View>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    userRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18 },
    userBubble: {
      maxWidth: "80%",
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderBottomLeftRadius: 22,
      borderBottomRightRadius: 6,
      backgroundColor: c.inverse,
    },
    userText: { fontSize: 17, lineHeight: 23, color: c.onInverse },
    assistant: { marginTop: 22, marginHorizontal: 4, gap: 10 },
    statusLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 },
    statusSpinner: { transform: [{ scale: 0.8 }] },
    statusText: { flexShrink: 1, fontSize: 15, color: c.muted },
    errorText: { color: c.danger },
    standalone: { marginTop: 22, marginHorizontal: 4 },
  })
)
