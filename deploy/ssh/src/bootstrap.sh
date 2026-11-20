# Starts a release on the server: takes the deploy lock, unpacks the upload into its release
# folder, installs Bun and the dependencies, then hands over to the release's own runner
# (server/release.ts), which still holds the lock. Runs detached from the SSH session, so a
# dropped connection never leaves half a deploy; the laptop follows its log.
#
# Usage: bootstrap.sh <name> <release-id> <project-path> <bun-version> <incoming> <plan>

set -euo pipefail
name=$1 release_id=$2 project_path=$3 bun_version=$4 incoming=$5 plan=$6

root="$HOME/$name"
release="$root/releases/$release_id"
project="$release/$project_path"
bun_dir="$HOME/.sixb/bun/$bun_version"
bun="$bun_dir/bun"

# Progress for the laptop, as RFC 7464 JSON text sequences; a release ends with its exit code.
event() { printf '\036{"step":"%s","status":"%s"}\n' "$1" "$2"; }
trap 'printf "\036{\"exit\":%d}\n" "$?"' EXIT
# `systemctl --user` finds the account's systemd through this; SSH sessions usually set it.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

exec 9> "$root/deploy/lock"
if ! flock -n 9; then
  echo "Waiting for another deploy or script run of $name to finish…"
  if ! flock -w 600 9; then
    echo "Another deploy or script run of $name has held its lock for 10 minutes." >&2
    exit 1
  fi
fi

event "Prepare release" "running"
rm -rf "$release"
mkdir -p "$release" "$root/shared"
(cd "$incoming" && tar -c -f - --exclude=.env .) | (cd "$release" && tar -x -f -)
chmod 755 "$release"
mkdir -p "$project"
# A deployment from before releases kept its `.env` in its code folder.
if [ ! -L "$root/code" ] && [ -f "$root/code/$project_path/.env" ] && [ ! -f "$root/shared/.env" ]; then
  cp -p "$root/code/$project_path/.env" "$root/shared/.env"
  chmod 600 "$root/shared/.env"
fi
rm -rf "$incoming"
# Uploads and logs of deploys long gone.
find "$root/deploy/incoming" "$root/deploy/runs" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2> /dev/null || true
event "Prepare release" "done"

event "Install Bun $bun_version" "running"
if [ ! -x "$bun" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) echo "Bun has no Linux build for $(uname -m)." >&2; exit 1 ;;
  esac
  # Bun's default x64 build needs AVX2; older CPUs take the baseline build.
  if [ "$arch" = x64 ] && ! grep -q avx2 /proc/cpuinfo; then arch=x64-baseline; fi
  asset="bun-linux-$arch"
  url="https://github.com/oven-sh/bun/releases/download/bun-v$bun_version"
  download="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$download/$asset.zip" "$url/$asset.zip"
  curl -fsSL --retry 3 -o "$download/SHASUMS256.txt" "$url/SHASUMS256.txt"
  (cd "$download" && grep " $asset.zip\$" SHASUMS256.txt | sha256sum -c --quiet -)
  unzip -q "$download/$asset.zip" -d "$download"
  mkdir -p "$bun_dir"
  mv "$download/$asset/bun" "$bun"
  rm -rf "$download"
fi
# Dependency lifecycle scripts call `node`; with none installed, Bun runs them.
command -v node > /dev/null || ln -sf "$bun" "$bun_dir/node"
"$bun" --version
event "Install Bun $bun_version" "done"

event "Install dependencies" "running"
cd "$project"
PATH="$bun_dir:$PATH" "$bun" install --frozen-lockfile --backend=hardlink
for package in @sixb/cli:sixb @sixb/deploy-ssh:sixb-deploy-ssh; do
  if [ ! -e "node_modules/.bin/${package#*:}" ]; then
    echo "${package%%:*} is not installed. Add it to the project's dependencies." >&2
    exit 1
  fi
done
if [ ! -e node_modules/@sixb/deploy-ssh/src/server/release.ts ]; then
  echo "This commit's @sixb/deploy-ssh predates 0.3.0, which this deploy needs. Upgrade it, or deploy the commit with its own sixb." >&2
  exit 1
fi
event "Install dependencies" "done"

"$bun" "node_modules/.bin/sixb-deploy-ssh" release "$plan"
