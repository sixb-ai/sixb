import { getAgentOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { AgentChat } from "../agent/agent-chat"
import { THREADS_PATH, threadPath } from "../agent/thread-navigation"
import { useAppMessages } from "../locale"
import { readDocumentIdentity } from "../shell/brand"
import { Mosaic } from "./mosaic"

/**
 * The home page until a project adds `app/page.tsx`: a conversation with the project's agent that
 * continues on the agent's own page once sent. Without an agent it shows the app's name.
 */
export function HomePage() {
  const navigate = useNavigate()
  const agent = useQuery(getAgentOptions())

  return (
    // The page's height inside a shell, or the viewport's when the layout adds no frame.
    <div className="relative flex h-dvh max-h-full min-h-0 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden md:block">
        <Mosaic />
      </div>
      {agent.isPending ? null : agent.data ? (
        <AgentChat
          className="relative z-10 min-h-0 flex-1"
          threadId={null}
          welcomeContent={<Welcome />}
          onNavigateHome={() => navigate("/")}
          onNavigateThread={(threadId) => navigate(threadPath(threadId))}
          onOpenThreads={() => navigate(THREADS_PATH)}
        />
      ) : (
        <Empty />
      )}
    </div>
  )
}

function Welcome() {
  const messages = useAppMessages().home
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
      <h1 className="text-4xl leading-none font-semibold tracking-tight md:text-5xl">
        {messages.title}
        <br />
        <span className="text-muted-foreground">{messages.subtitle}</span>
      </h1>
      <p className="max-w-[46ch] text-base text-muted-foreground">{messages.description}</p>
    </div>
  )
}

function Empty() {
  const messages = useAppMessages().home
  const [identity] = useState(readDocumentIdentity)
  return (
    <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-[25vh] text-center">
      <h1 className="text-4xl leading-none font-semibold tracking-tight md:text-5xl">
        {identity.title}
      </h1>
      <p className="text-base text-muted-foreground">{messages.empty}</p>
    </div>
  )
}
