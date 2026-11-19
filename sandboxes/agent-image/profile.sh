# The bash tool runs `bash -lc`, so this restores the image's ENV on providers that do not apply it.
# Values a provider or caller already set win.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/sixb/browsers}"
export LANG="${LANG:-C.UTF-8}"
export MPLBACKEND="${MPLBACKEND:-Agg}"
export PIP_DISABLE_PIP_VERSION_CHECK="${PIP_DISABLE_PIP_VERSION_CHECK:-1}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export HYPERFRAMES_BROWSER_PATH="${HYPERFRAMES_BROWSER_PATH:-/usr/local/bin/chrome-headless-shell}"
export HYPERFRAMES_NO_TELEMETRY="${HYPERFRAMES_NO_TELEMETRY:-1}"
export HYPERFRAMES_NO_UPDATE_CHECK="${HYPERFRAMES_NO_UPDATE_CHECK:-1}"
export HYPERFRAMES_NO_AUTO_INSTALL="${HYPERFRAMES_NO_AUTO_INSTALL:-1}"
export HYPERFRAMES_SKIP_SKILLS="${HYPERFRAMES_SKIP_SKILLS:-1}"
