import { AgentPanel, handoffAgentSurfaceThread } from "@sixb/app/agents"
import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"

const ASSISTANT_ID = "operations-assistant"

export default function NorthlineConversationPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const threadId = id ?? null

  useEffect(() => {
    if (threadId) handoffAgentSurfaceThread(ASSISTANT_ID, threadId)
  }, [threadId])

  const returnToHome = () => navigate("/")

  return (
    <section className="h-full min-h-[34rem]">
      <AgentPanel
        agentId={ASSISTANT_ID}
        threadId={threadId}
        onThreadChange={(nextThreadId) => {
          if (!nextThreadId) return
          navigate(`/chat/${encodeURIComponent(nextThreadId)}`)
        }}
        onBackHome={returnToHome}
        onNewThread={returnToHome}
        splitDocumentPreview
        composerPlaceholder="Ask Northline about today’s work"
        className="h-full bg-transparent"
      />
    </section>
  )
}
