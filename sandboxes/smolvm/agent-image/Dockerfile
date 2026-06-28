# Canonical sixb agent sandbox image.
#
# Spin-up scales with image size, so this stays lean — only what the agent
# actually uses through the API gateway:
#   bash            the agent bash tool runs `bash -lc`
#   curl, jq        the gateway is HTTP + JSON
#   git, ripgrep    common agent file/repo work
#   python3         scripting beyond jq (stdlib only — no pip; PyPI is
#                   unreachable under the sandbox's gateway-only egress)
#
# ~73 MB packed; boots in well under the model's first-response latency, so the
# sandbox is ready before the agent asks for it. Edit this and rebuild with
# `bun run agent:image`; add heavy runtimes only when genuinely needed.
FROM alpine:3.20

RUN apk add --no-cache bash curl jq git ca-certificates ripgrep python3
