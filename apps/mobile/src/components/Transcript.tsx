import { useEffect, useRef } from "react"
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import { messageFiles, messageText, normalizeMessageParts } from "../lib/agent/types"
import type { Conversation } from "../lib/agent/use-conversation"
import { makeStyles, usePalette } from "../lib/theme"
import { PendingFiles, UserFiles } from "./attachments"
import { AssistantParts, ErrorNote, RISE, Thinking, UserBubble } from "./messages"

// Keep following new content while the reader is within this distance of the bottom.
const FOLLOW_THRESHOLD = 80

interface TranscriptProps {
  readonly conversation: Conversation
  /** Space to leave below the last message for the floating composer. */
  readonly bottomSpace: number
}

/**
 * A conversation's messages. What arrives while the screen is open animates in: the message just
 * sent, then the reply part by part. Saved messages render still, because each one replaces a
 * bubble or a live reply that already animated in at the same spot.
 */
export function Transcript({ conversation, bottomSpace }: TranscriptProps) {
  const styles = useStyles()
  const c = usePalette()
  const scrollRef = useRef<ScrollView>(null)
  const following = useRef(true)

  // Sending brings the reader back to the end, wherever they had scrolled.
  useEffect(() => {
    if (conversation.pendingText !== null) following.current = true
  }, [conversation.pendingText])

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    following.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_THRESHOLD
  }

  if (conversation.loadError !== null) {
    return (
      <View style={[styles.unavailable, { paddingBottom: bottomSpace }]}>
        <Text style={styles.unavailableText}>{conversation.loadError}</Text>
        <Pressable accessibilityRole="button" onPress={conversation.reload} style={styles.retry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: bottomSpace }]}
      keyboardDismissMode="interactive"
      onScroll={onScroll}
      scrollEventThrottle={32}
      onContentSizeChange={() => {
        if (following.current) scrollRef.current?.scrollToEnd({ animated: true })
      }}
    >
      {conversation.loading ? (
        <ActivityIndicator style={styles.loading} color={c.muted} />
      ) : (
        <Animated.View entering={FadeIn.duration(220)}>
          {conversation.messages.map((message) =>
            message.role === "user" ? (
              <View key={message.id}>
                <UserFiles message={message} files={messageFiles(message)} />
                <UserBubble text={messageText(message)} />
              </View>
            ) : message.role === "assistant" ? (
              <AssistantParts
                key={message.id}
                parts={normalizeMessageParts(message.parts)}
                message={message}
              />
            ) : null
          )}
        </Animated.View>
      )}
      {conversation.pendingText !== null ? (
        <Animated.View entering={RISE}>
          <PendingFiles files={conversation.pendingFiles} />
          <UserBubble text={conversation.pendingText} />
        </Animated.View>
      ) : null}
      {conversation.liveParts.length > 0 ? (
        <AssistantParts parts={conversation.liveParts} animated />
      ) : null}
      {conversation.awaitingFirstToken ? <Thinking /> : null}
      {conversation.error ? <ErrorNote message={conversation.error} /> : null}
    </ScrollView>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    root: { flex: 1 },
    content: { paddingHorizontal: 20 },
    loading: { marginTop: 40 },
    unavailable: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
    unavailableText: { fontSize: 15, lineHeight: 21, color: c.muted, textAlign: "center" },
    retry: { height: 44, justifyContent: "center" },
    retryText: { fontSize: 15, fontWeight: "600", color: c.link },
  })
)
