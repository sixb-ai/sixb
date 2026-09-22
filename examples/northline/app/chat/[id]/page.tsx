import { AgentPanel, handoffAgentSurfaceThread } from "@sixb/app/agents"
import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"

export default function NorthlineConversationPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const threadId = id ?? null

  useEffect(() => {
    if (threadId) handoffAgentSurfaceThread(threadId)
  }, [threadId])

  const returnToHome = () => navigate("/")

  return (
    <section className="h-full min-h-[34rem]">
      <AgentPanel
        threadId={threadId}
        onThreadChange={(nextThreadId) => {
          if (!nextThreadId) return
          navigate(`/chat/${encodeURIComponent(nextThreadId)}`)
        }}
        onNewThread={returnToHome}
        splitDocumentPreview
        composerPlaceholder="Ask Northline about today’s work"
        className="h-full bg-transparent"
      />
    </section>
  )
}
