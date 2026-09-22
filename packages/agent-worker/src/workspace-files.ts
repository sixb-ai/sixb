/** Run before materialization and before saving. Git exclusions prevent accidental staging,
 * not deliberate publication; tracked runtime files must still block cleanup.
 */
export function workspaceRunFilesScript(hasSource: boolean): string {
  const git = hasSource
    ? `
git rev-parse --git-dir >/dev/null
tracked=$(git ls-files -- .sixb/agent)
test -z "$tracked"
# Managed sources are ordinary clones. Never write through redirected Git metadata.
test -d .git
test ! -L .git
test ! -L .git/info
test ! -L .git/info/exclude
mkdir -p .git/info
test ! -e .git/info/exclude || test -f .git/info/exclude
excluded=false
if test -f .git/info/exclude; then
  while IFS= read -r rule || test -n "$rule"; do
    if test "$rule" = '/.sixb/agent/'; then excluded=true; break; fi
  done < .git/info/exclude
fi
if test "$excluded" = false; then
  printf '\\n/.sixb/agent/\\n' >> .git/info/exclude
fi
# Repository ignore rules take precedence over local exclusions. Fail before writing secrets
# when a repository explicitly re-includes our reserved directory.
git check-ignore -q -- .sixb/agent/
`
    : ""
  return `set -e
test ! -L .sixb
${git}
rm -rf -- .sixb/agent`
}
