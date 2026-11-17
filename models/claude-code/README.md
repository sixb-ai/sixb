# @sixb/claude-code

Use Claude through the Claude Code installed and signed in on your computer. The calls are billed
the way your Claude Code is: a Claude subscription you signed in with pays for them, with no
Anthropic API key in your project.

```ts
import { claudeCode } from "@sixb/claude-code"

export const opus = claudeCode("opus", { reasoning: "high" })
```

Give it to an agent, a project's model catalog (`models: { language: [opus] }`), or `generate()`
like any other language model.

## What runs where

Sixb keeps running the Agent: its system prompt, its tools and its loop. Claude Code only answers.
It runs without its own tools, without your Claude Code settings, `CLAUDE.md` files, skills or MCP
servers, and with Sixb's system prompt in place of its own.

| | |
| --- | --- |
| Tools | Sixb's tools are offered to Claude Code. When the model calls one, the answer ends there, and Sixb runs the tool as it does for every provider. |
| Conversation | Claude Code keeps each conversation in a session. Each answer records its session, so the next call resumes it and sends only the tool results or the next message. |
| Prompt caching | Claude Code caches the session's prompt itself; `caching` options are ignored. |
| Structured output | Supported, through Claude Code's own structured output. |
| Files | Images and PDFs in user messages. |
| Reasoning | Sixb's levels map to Claude Code's effort; `minimal` runs as `low`. |
| Cost | Not reported. A subscription bills by plan, not by call. |

Claude Code cannot resume a session it no longer has, such as one its cleanup removed, or a
conversation whose earlier answers came from another model provider. Then a new session starts
with the conversation so far as a transcript, and with tool calls written out as text.

## Models

`claudeCode.catalog.list()` returns the models Claude Code offers the account it is signed in
with, such as `opus`, `sonnet`, `haiku` and full model ids, with their names and effort levels.
Loading the list starts Claude Code briefly, once an hour at most. Context windows are not listed:
pass `contextWindow` through `models` when the Agent should size its context to one.

## Options

```ts
import { createClaudeCode } from "@sixb/claude-code"

const provider = createClaudeCode({
  // Run the `claude` on your PATH instead of the one the SDK ships.
  executable: "/usr/local/bin/claude",
  // Bill an API key instead of Claude Code's sign-in.
  apiKey: () => process.env.CLAUDE_CODE_API_KEY,
  // Where Claude Code runs, and so where its sessions are filed under ~/.claude/projects.
  cwd: "/tmp/sixb-claude-code",
})

const sonnet = provider("sonnet", { name: "Sonnet", description: "For everyday questions." })
```

`ANTHROPIC_API_KEY` in the environment is not passed to Claude Code, because Claude Code would bill
it ahead of its sign-in. Pass `apiKey` to use a key on purpose.

## Requirements

- Claude Code signed in on the machine that runs the model: run `claude`, then `/login`. A call
  made while it is signed out fails with `Claude Code is not signed in`.
- Each call starts a Claude Code process, which adds its startup time to every model call.

This provider is for running Sixb on your own computer with your own Claude account. Anthropic does
not allow products built on the Claude Agent SDK to offer claude.ai sign-in to their users unless
Anthropic has approved it: a deployment that serves other people should use `@sixb/anthropic` with
an API key.
