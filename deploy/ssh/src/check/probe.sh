# Reports what a deploy needs to know about the server, as the deploy account, changing nothing.
# Prints one `fact<TAB>key<TAB>value` line per fact; check/judge.ts decides what each means.
# The caller sets SIXB_NAME (the deployment), SIXB_PROJECT (the project's path in its repository),
# SIXB_PORTS (the slots' loopback ports) and SIXB_CHROMIUM (1 when the project prints with
# Chromium) above this script.

fact() { printf 'fact\t%s\t%s\n' "$1" "$(printf '%s' "$2" | tr '\t\n' '  ')"; }
yes_no() { if "$@" > /dev/null 2>&1; then echo yes; else echo no; fi; }

# Server
# In a subshell: os-release sets NAME, ID and others over this script's own variables.
if [ -r /etc/os-release ]; then
  (
    # shellcheck disable=SC1091
    . /etc/os-release
    fact os.id "${ID:-}"
    fact os.like "${ID_LIKE:-}"
    fact os.name "${PRETTY_NAME:-}"
  )
fi
fact os.systemd "$(yes_no command -v systemctl)"
fact os.arch "$(uname -m)"
missing=""
for tool in curl unzip tar flock setsid sha256sum ss; do
  command -v "$tool" > /dev/null || missing="$missing $tool"
done
# The deploy reads modes with GNU stat's `-c`.
stat -c %a "$HOME" > /dev/null 2>&1 || missing="$missing stat"
fact os.missing "${missing# }"
fact linger "$(yes_no test -e "/var/lib/systemd/linger/$USER")"

# Caddy
fact caddy.version "$(caddy version 2> /dev/null | cut -d' ' -f1 | sed 's/^v//')"
fact caddy.reload "$(yes_no sudo -n -l /usr/bin/systemctl reload caddy)"
routes="/etc/caddy/sixb.d/$USER"
fact caddy.routes "$routes"
fact caddy.routes-writable "$(yes_no test -d "$routes" -a -w "$routes")"
fact caddy.routes-imported "$(yes_no grep -qsF "import $routes/*.caddy" "/etc/caddy/sixb.d/$USER.caddy")"
fact caddy.caddyfile-imports "$(yes_no grep -qsF 'import /etc/caddy/sixb.d/*.caddy' /etc/caddy/Caddyfile)"
fact caddy.admin-on-localhost "$(yes_no sh -c "ss -ltnH | grep -qE '(127\\.0\\.0\\.1|\\[::1\\]):2019 '")"

# Deployments on this server, by their systemd units: a server runs one
others="$(
  for unit in "$HOME"/.config/systemd/user/sixb-*.service; do
    [ -e "$unit" ] || continue
    deployment="${unit##*/sixb-}"
    deployment="${deployment%.service}"
    deployment="${deployment%@}"
    [ "$deployment" = "$SIXB_NAME" ] || echo "$deployment"
  done | sort -u | tr '\n' ' '
)"
fact deployments.others "${others% }"

# Settings: the token a deploy pulls .env with, or the .env kept on the server
file_fact() {
  if [ -f "$2" ]; then fact "$1" "$(stat -c '%a %s' "$2")"; else fact "$1" missing; fi
}
root="$HOME/$SIXB_NAME"
file_fact file.env-token "$root/env-token"
file_fact file.shared-env "$root/shared/.env"
# A deployment from before releases kept its .env in its code folder, which the first deploy moves.
if [ ! -L "$root/code" ]; then
  file_fact file.legacy-env "$root/code/$SIXB_PROJECT/.env"
fi

# Ports: free, held by this account, or held by something else
uid="$(id -u)"
for port in $SIXB_PORTS; do
  listening="$(ss -ltnHe "sport = :$port" 2> /dev/null)"
  if [ -z "$listening" ]; then
    fact "port.$port" free
  elif printf '%s' "$listening" | grep -q "uid:$uid\\b"; then
    fact "port.$port" own
  else
    fact "port.$port" other
  fi
done

fact disk.free-kb "$(df -Pk "$HOME" | awk 'NR == 2 { print $4 + 0 }')"

# Chromium: the libraries the downloaded browser can't find, or, before the first download, the
# few that a server without Chromium's dependencies lacks
if [ "${SIXB_CHROMIUM:-0}" = 1 ]; then
  browser="$(find "$HOME/.cache/ms-playwright" -path '*/chrome-headless-shell-linux64/chrome-headless-shell' -type f 2> /dev/null | sort -V | tail -n 1)"
  if [ -n "$browser" ]; then
    fact chromium.checked "$browser"
    fact chromium.missing "$(ldd "$browser" 2> /dev/null | awk '/not found/ { print $1 }' | tr '\n' ' ')"
  else
    fact chromium.checked "system libraries"
    ldconfig="$(command -v ldconfig || echo /sbin/ldconfig)"
    missing=""
    for lib in libnss3.so libatk-1.0.so.0 libatk-bridge-2.0.so.0 libgbm.so.1 libxkbcommon.so.0 libasound.so.2; do
      "$ldconfig" -p 2> /dev/null | grep -qF "$lib" || missing="$missing $lib"
    done
    fact chromium.missing "${missing# }"
  fi
fi
