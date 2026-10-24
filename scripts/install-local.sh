#!/usr/bin/env bash
# Build this repo into the `9router` CLI and install it globally over any
# existing install, keeping your data in ~/.9router. See scripts/INSTALL-LOCAL.md.
#
#   scripts/install-local.sh                 # pull master, build, back up, install, start
#   scripts/install-local.sh --no-pull       # build the current checkout as-is
#   scripts/install-local.sh --no-start      # install only
#   scripts/install-local.sh --tray          # start in the menu-bar tray
#   scripts/install-local.sh --port 20128    # start on another port
set -euo pipefail

PULL=1 START=1 TRAY=0 PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0 ;;
    --no-start) START=0 ;;
    --tray) TRAY=1 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
DATA="${DATA_DIR:-$HOME/.9router}"

say "Checking prerequisites"
command -v node >/dev/null || die "node not found. Install Node.js 22.5 or newer."
command -v npm  >/dev/null || die "npm not found."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node $(node -v) is too old: need 22.5+ for the built-in SQLite driver the budget limit relies on."
fi
echo "node $(node -v), npm $(npm -v)"

if [ "$PULL" -eq 1 ]; then
  say "Updating master"
  [ -z "$(git status --porcelain)" ] || die "Uncommitted changes in $REPO. Commit/stash them, or rerun with --no-pull."
  git checkout master
  git pull --ff-only origin master
fi
echo "commit $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

say "Installing dependencies"
npm install --no-audit --no-fund
# The CLI package has its own build deps (esbuild for the MITM bundle). Skip its
# postinstall here: that warms ~/.9router/runtime for an installed CLI, and the
# global install below runs it anyway.
npm --prefix cli install --no-audit --no-fund --ignore-scripts

say "Building the CLI package (takes a few minutes)"
VERSION="$(node -p 'require("./cli/package.json").version')"
PKG="$REPO/9router-$VERSION.tgz"
rm -f "$PKG"
npm run cli:pack
[ -f "$PKG" ] || die "Build finished but $PKG was not produced."

if [ -d "$DATA" ]; then
  say "Backing up $DATA"
  BACKUP="$HOME/9router-backup-$(date +%Y%m%d-%H%M%S)"
  # Skip the downloadable runtime/ and logs/; everything that holds state is copied.
  mkdir -p "$BACKUP"
  for item in "$DATA"/* "$DATA"/.[!.]*; do
    [ -e "$item" ] || continue
    case "$(basename "$item")" in runtime|logs) continue ;; esac
    cp -R "$item" "$BACKUP/"
  done
  echo "backup: $BACKUP"
else
  echo "No existing data at $DATA (fresh install)."
fi

say "Installing 9router $VERSION globally"
INSTALLED="$(npm ls -g --depth=0 9router 2>/dev/null | sed -n 's/.*9router@//p' | head -1 || true)"
[ -n "$INSTALLED" ] && echo "replacing installed 9router@$INSTALLED"
npm install -g --no-audit --no-fund "$PKG"
hash -r
RUNNING_VERSION="$(9router --version 2>/dev/null || true)"
[ "$RUNNING_VERSION" = "$VERSION" ] || die "9router on PATH reports '$RUNNING_VERSION', expected $VERSION. Check: which 9router"
echo "9router $RUNNING_VERSION at $(command -v 9router)"

cat <<EOF

Installed. Your data in $DATA is untouched; the first start upgrades the schema
in place and saves a copy under $DATA/db/backups/ first.

Always start with --skip-update: the update prompt installs the upstream npm
package and replaces this build (you would lose the per-key budget feature).
To roll back: npm install -g 9router@${INSTALLED:-<previous-version>}
EOF

if [ "$START" -eq 1 ]; then
  ARGS=(--skip-update)
  [ "$TRAY" -eq 1 ] && ARGS+=(--tray)
  [ -n "$PORT" ] && ARGS+=(--port "$PORT")
  say "Starting: 9router ${ARGS[*]}"
  # The CLI stops any older 9router process before it starts the new one.
  exec 9router "${ARGS[@]}"
fi
