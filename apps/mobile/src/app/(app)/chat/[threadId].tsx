import { useLocalSearchParams, useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { ChatFrame, ChatHeader } from "../../../components/ChatFrame"
import { Composer } from "../../../components/Composer"
import { Transcript } from "../../../components/Transcript"
import { chatTitle } from "../../../lib/agent/titles"
import { useConversation } from "../../../lib/agent/use-conversation"

/** A conversation opened from History. New ones start in place on Today. */
export default function ConversationScreen() {
  const router = useRouter()
  const { threadId } = useLocalSearchParams<{ threadId: string }>()
  const conversation = useConversation(threadId)

  return (
    <>
      <StatusBar style="auto" />
      <ChatFrame
        header={
          <ChatHeader
            title={chatTitle(conversation.thread)}
            backLabel="Back"
            onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          />
        }
        composer={
          <Composer
            placeholder={conversation.agentAvailable ? "Reply" : "This workspace has no agent"}
            responding={conversation.responding}
            disabled={!conversation.agentAvailable || conversation.loadError !== null}
            onSend={conversation.send}
            onStop={conversation.stop}
          />
        }
      >
        {(composerSpace) => <Transcript conversation={conversation} bottomSpace={composerSpace} />}
      </ChatFrame>
    </>
  )
}
