import { AgentPanel, setAgentSurfaceMode } from "@sixb/app/agents"
import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { NorthlineWordmark } from "./_components/northline-wordmark"

export default function NorthlineHomePage() {
  const navigate = useNavigate()
  useEffect(() => {
    setAgentSurfaceMode("collapsed")
  }, [])

  const changeThread = (nextThreadId: string | null) => {
    if (!nextThreadId) return
    navigate(`/chat/${encodeURIComponent(nextThreadId)}`)
  }

  return (
    <section className="h-full min-h-[34rem]">
      <AgentPanel
        threadId={null}
        onThreadChange={changeThread}
        compact={false}
        welcomeContent={<NorthlineWordmark className="h-16 sm:h-20" />}
        composerPlaceholder="Ask Northline about today’s work"
        className="h-full bg-transparent"
      />
    </section>
  )
}
