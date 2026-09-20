import { createAgentThread, postAgentThreadMessage } from "@sixb/client"

const { data } = await createAgentThread({
  body: { title: "Campaign review" },
  throwOnError: true,
})

await postAgentThreadMessage({
  path: { threadId: data.thread.id },
  body: { text: "Analyze this month's campaigns" },
  throwOnError: true,
})
