#!/bin/sh
# Run the jobs board and Flisk Bot as two plain processes (no Docker), for a fleet pod or any Linux box.
#   sh scripts/pod-run.sh            from the project root; needs bun (installed here if missing)
# Settings (all optional): DATA_DIR (default ./pod-data), JOBS_PORT 4001, BOT_PORT 3000, PUBLIC_ORIGIN.
# The board uses SQLite in DATA_DIR/jobs.db and the bot keeps its sessions in DATA_DIR/bot.
# A pod's disk can disappear when the pod stops: copy DATA_DIR out before stopping if you need it.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/pod-data}"
JOBS_PORT="${JOBS_PORT:-4001}"
BOT_PORT="${BOT_PORT:-3000}"
mkdir -p "$DATA_DIR/bot"

if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  PATH="$BUN_INSTALL/bin:$PATH"
fi

# Board first: the bot registers itself on it the first time it polls.
( cd "$ROOT/services/bot/jobs" && PORT="$JOBS_PORT" JOBS_DB="$DATA_DIR/jobs.db" PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost:$JOBS_PORT}" exec bun src/index.ts ) &
JOBS_PID=$!
( cd "$ROOT/services/bot/bot" && PORT="$BOT_PORT" AGENT_STATE_DIR="$DATA_DIR/bot" JOBS_URL="http://localhost:$JOBS_PORT" JOBS_PUBLIC_URL="${PUBLIC_ORIGIN:-http://localhost:$JOBS_PORT}" BOT_POLL_SECONDS="${BOT_POLL_SECONDS:-10}" exec bun src/index.ts ) &
BOT_PID=$!

trap 'kill $JOBS_PID $BOT_PID 2>/dev/null || true' INT TERM
echo "board http://localhost:$JOBS_PORT  bot http://localhost:$BOT_PORT  data $DATA_DIR"
wait
