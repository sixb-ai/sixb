# syntax=docker/dockerfile:1
# Shared Linux toolchain for Sixb agents. No project data or credentials belong here.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl file findutils git gzip jq procps ripgrep \
    sqlite3 tar unzip zip xz-utils bzip2 p7zip-full patch rsync \
    python3 python3-venv \
    pandoc tesseract-ocr tesseract-ocr-eng qpdf \
    libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils \
    fonts-dejavu-core fonts-liberation2 fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/sixb/python

FROM base AS runtime
COPY requirements.lock /opt/sixb/requirements.lock
# Writable by any UID: providers do not all run commands as the same user.
RUN /opt/sixb/python/bin/pip install --no-cache-dir --require-hashes -r /opt/sixb/requirements.lock \
    && chmod -R a+rwX /opt/sixb/python
COPY --chmod=0755 scripts/python3 /usr/local/bin/python3
COPY --chmod=0755 scripts/pip /usr/local/bin/pip
RUN ln -s /usr/local/bin/python3 /usr/local/bin/python \
    && ln -s /usr/local/bin/pip /usr/local/bin/pip3 \
    && ln -s /opt/sixb/python/bin/uv /usr/local/bin/uv \
    && ln -s /opt/sixb/python/bin/pytest /usr/local/bin/pytest \
    && ln -s /opt/sixb/python/bin/ruff /usr/local/bin/ruff
COPY tooling/package.json tooling/bun.lock /opt/sixb/js/
RUN cd /opt/sixb/js && bun install --frozen-lockfile --production --ignore-scripts
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/sixb/browsers
# Install the matching browser and its OS dependencies while building, including offline use.
RUN node /opt/sixb/js/node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 scripts/sixb-render /usr/local/bin/sixb-render
COPY --chmod=0644 profile.sh /etc/profile.d/sixb.sh
# Fail the build rather than publish an image missing a tool the skills rely on.
RUN for tool in bash node bun python python3 pip pip3 uv pytest ruff git rg jq curl zip unzip \
      7z xz bzip2 patch rsync sqlite3 pandoc tesseract qpdf libreoffice pdftoppm pdfinfo \
      pdftotext fc-match realpath head tail base64 sixb-render; do \
      command -v "$tool" >/dev/null || { echo "[SixbImage] missing $tool" >&2; exit 1; }; \
    done \
    && mkdir -p /workspace \
    && chmod 0777 /workspace
# Keep these and PLAYWRIGHT_BROWSERS_PATH in sync with profile.sh, which restores them for login
# shells when a provider does not apply image ENV.
ENV LANG=C.UTF-8 MPLBACKEND=Agg PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
# No USER: SmolVM creates its working directory (a host-style path) as the image user, which a
# non-root default cannot do. Providers that run as another UID rely on the writable paths above.
# Providers run commands explicitly; Vercel does not execute ENTRYPOINT/CMD.
CMD ["bash"]
