# Migration

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Upgrading from defined agents

- Replace `defineAgent` and `createSixb({ agents })` with project `models` and `tools`.
- Move reusable instructions into `skills/`; `agents/` is no longer discovered.
- Use `sixb.agent` and `GET /api/agent`.
- Existing conversation history is preserved without its former Agent identity.
