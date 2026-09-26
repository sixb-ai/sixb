# The bash tool runs `bash -lc`, so this restores the image's ENV on providers that do not apply it.
# Values a provider or caller already set win.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/sixb/browsers}"
export LANG="${LANG:-C.UTF-8}"
export MPLBACKEND="${MPLBACKEND:-Agg}"
export PIP_DISABLE_PIP_VERSION_CHECK="${PIP_DISABLE_PIP_VERSION_CHECK:-1}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
