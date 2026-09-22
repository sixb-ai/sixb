export const starterPrompt = `Help me build a project with Sixb, a TypeScript framework for ontology-powered apps and AI.

If I haven't described what I want to build, ask me first. Confirm a project name and location before creating files.

Read https://docs.sixb.ai/llms.txt and follow the relevant documentation links before choosing APIs. Start with the setup guide at https://docs.sixb.ai/README.md. Use the documentation and installed package versions rather than guessing APIs.

Use Bun. Scaffold with bun create sixb <project-name>, then enter the project directory and run bun install. Read the generated project instructions before making changes.

Build a small, working first version around my use case. Define the shared model in TypeScript and use Sixb's runtime for the app or AI features it needs. Start with local sample data; ask before connecting real accounts or writing to external systems.

Run the project's available checks, fix any issues, and explain what you built. Show me how to start it with bun run dev and where to open it.`
