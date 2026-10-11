import { StatusBar } from "expo-status-bar"
import { useCallback, useEffect, useState } from "react"
import { BackHandler, ScrollView, StyleSheet, Text } from "react-native"
import Animated, { FadeIn, FadeOut, FadeOutUp } from "react-native-reanimated"
import { ChatFrame, ChatHeader } from "../../components/ChatFrame"
import { Composer } from "../../components/Composer"
import { Transcript } from "../../components/Transcript"
import { WorkspaceHeader } from "../../components/WorkspaceHeader"
import { chatTitle } from "../../lib/agent/titles"
import { type Attachment, useConversation } from "../../lib/agent/use-conversation"
import { greeting, longDate } from "../../lib/format"
import { makeStyles } from "../../lib/theme"
import { useWorkspaceIdentity } from "../../lib/workspace-identity"

export default function TodayScreen() {
  // Asking from Today turns the screen into that conversation. Going back mounts a fresh Today, so
  // the next question starts a new conversation.
  const [visit, setVisit] = useState(0)
  const backToToday = useCallback(() => setVisit((count) => count + 1), [])
  return <Today key={visit} onBack={backToToday} />
}

function Today({ onBack }: { readonly onBack: () => void }) {
  const styles = useStyles()
  const conversation = useConversation(null)
  const [chatting, setChatting] = useState(false)

  const { send: sendMessage } = conversation
  const send = useCallback(
    (text: string, attachments: readonly Attachment[]) => {
      setChatting(true)
      return sendMessage(text, attachments)
    },
    [sendMessage]
  )

  useEffect(() => {
    if (!chatting) return
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack()
      return true
    })
    return () => subscription.remove()
  }, [chatting, onBack])

  const header = chatting ? (
    <Animated.View key="chat" entering={FadeIn.duration(220)}>
      <ChatHeader
        title={chatTitle(conversation.thread, "New chat")}
        backLabel="Back to Today"
        onBack={onBack}
      />
    </Animated.View>
  ) : (
    <Animated.View key="home" entering={FadeIn.duration(220)} exiting={FadeOut.duration(150)}>
      <WorkspaceHeader />
    </Animated.View>
  )

  const composer = (
    <Composer
      placeholder={
        chatting
          ? "Reply"
          : conversation.agentAvailable
            ? "Ask or find anything"
            : "This workspace has no agent"
      }
      responding={conversation.responding}
      disabled={!conversation.agentAvailable}
      onSend={send}
      onStop={conversation.stop}
    />
  )

  return (
    <>
      <StatusBar style="auto" />
      <ChatFrame header={header} composer={composer}>
        {(composerSpace) =>
          chatting ? (
            <Animated.View key="chat" entering={FadeIn.duration(260)} style={styles.fill}>
              <Transcript conversation={conversation} bottomSpace={composerSpace} />
            </Animated.View>
          ) : (
            <Animated.View
              key="home"
              entering={FadeIn.duration(260)}
              exiting={FadeOutUp.duration(220)}
              style={styles.fill}
            >
              <Home bottomSpace={composerSpace} />
            </Animated.View>
          )
        }
      </ChatFrame>
    </>
  )
}

/** Today at rest: the date and a greeting, centered above the ask bar. */
function Home({ bottomSpace }: { readonly bottomSpace: number }) {
  const styles = useStyles()
  const { user } = useWorkspaceIdentity()
  const firstName = user?.displayName?.split(/\s+/)[0]
  const now = new Date()

  return (
    <ScrollView
      contentContainerStyle={[styles.home, { paddingBottom: bottomSpace }]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.date}>{longDate(now)}</Text>
      <Text style={styles.headline} accessibilityRole="header">
        {greeting(now)}
        {firstName ? `, ${firstName}` : ""}.{"\n"}
        <Text style={styles.headlineMuted}>What can I help with?</Text>
      </Text>
    </ScrollView>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    fill: { flex: 1 },
    home: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 20 },
    date: { fontSize: 15, fontWeight: "600", color: c.muted },
    headline: {
      marginTop: 6,
      fontSize: 34,
      lineHeight: 38,
      fontWeight: "700",
      letterSpacing: -1,
      color: c.ink,
    },
    headlineMuted: { color: c.faint },
  })
)
