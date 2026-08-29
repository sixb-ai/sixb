# Managed SmolVM agent sandbox image.
#
# Spin-up scales with image size, so this stays lean — only what the agent
# actually uses through the API gateway:
#   bash            the agent bash tool runs `bash -lc`
#   node            the portable Sixb CLI runtime
#   busybox tools   read uses realpath, tail, head, and base64
#   git, ripgrep    common agent file/repo work
#   python3         scripting (stdlib only — no pip; PyPI is
#                   unreachable under the sandbox's gateway-only egress)
#
# The multi-platform base digest is pinned so rebuilding runtime-v1 is reproducible. Bump both this
# digest and the cache namespace in src/agent-image.ts when the managed image requirements change.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN apk add --no-cache bash git ca-certificates ripgrep python3
