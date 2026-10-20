#!/usr/bin/env bash
# Isolated daemon for this standalone checkout. Never uses the default Paseo home.
set -euo pipefail
cmd=${1:?usage: dev-daemon.sh up|cli|down [arguments...]}
shift
root=$(git rev-parse --show-toplevel)
cli="$root/node_modules/.bin/paseo"
[ -x "$cli" ] || { echo 'Run bun install first' >&2; exit 1; }
key=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,12))' "$root")
# Keep durable private test homes separate from Chromium's short Unix-socket temp paths.
state="${PASEO_SHARED_BROWSER_DEV_ROOT:-${TMPDIR:-/tmp}}/shared-browser-dev-$key"
home="$state/home"
clean() {
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID -u PASEO_HOST -u PASEO_HOME -u PASEO_LISTEN \
    -u CONTEXT_MODE_DIR -u CONTEXT_MODE_DATA_DIR -u CONTEXT_MODE_PLATFORM \
    -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u COPILOT_HOME -u XDG_CONFIG_HOME -u PI_CODING_AGENT_DIR \
    HOME="$state/fakehome" "$@"
}
dev_host() { clean "$cli" daemon status --home "$home" --json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).listen))'; }
stage() {
  rm -rf "$state/plugin"
  node "$root/scripts/stage-dev-plugin.mjs" "$root" "$state/plugin"
}
case "$cmd" in
  up)
    [ ! -f "$home/paseo.pid" ] || { echo "Run down before starting a fresh isolated environment" >&2; exit 1; }
    mkdir -p "$state/fakehome" "$state/work" "$home"
    [ -d "$state/work/.git" ] || git -C "$state/work" init -q
    [ -f "$home/config.json" ] || node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({version:1,pluginsEnabled:true,daemon:{listen:"127.0.0.1:0",relay:{enabled:false}}}))' "$home/config.json"
    stage
    clean env PASEO_HOME="$home" node "$state/plugin/scripts/prepare-dependencies.mjs"
    clean env PASEO_HOME="$home" node "$state/plugin/scripts/prepare-runtime.mjs"
    clean "$cli" daemon start --home "$home" >/dev/null
    host=$(dev_host)
    clean "$cli" plugin install "$state/plugin" --host "$host"
    echo "DEV_HOST=$host"
    echo "DEV_HOME=$home"
    echo "WORK_DIR=$state/work"
    ;;
  cli)
    clean "$cli" "$@" --host "$(dev_host)"
    ;;
  down)
    node "$root/scripts/stop-dev-runtime.mjs" "$home"
    clean "$cli" daemon stop --home "$home"
    rm -rf "$state"
    ;;
  *) echo "Unknown command: $cmd" >&2; exit 1 ;;
esac
