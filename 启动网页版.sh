#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found. Install Node.js 20 or newer, then run this script again." >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "npm was not found. Install Node.js 20 or newer, then run this script again." >&2
    exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "Node.js 20 or newer is required; detected $(node --version)." >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    npm install --no-audit --no-fund
fi

npm run build

PORT="${REINCARNATION_PORT:-4174}"
URL="${REINCARNATION_URL:-http://127.0.0.1:${PORT}}"
npm start &
SERVER_PID=$!

cleanup() {
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 60); do
    if command -v curl >/dev/null 2>&1 && curl --noproxy '*' --max-time 2 -fsS "$URL/api/health" >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 0.5
done

if [ "$READY" -ne 1 ]; then
    echo "The server did not become ready at $URL." >&2
    exit 1
fi

if [ "${NO_BROWSER:-0}" != "1" ]; then
    case "$(uname -s 2>/dev/null || true)" in
        Darwin*) command -v open >/dev/null 2>&1 && open "$URL" || true ;;
        MINGW*|MSYS*|CYGWIN*) command -v cmd.exe >/dev/null 2>&1 && cmd.exe /c start "" "$URL" || true ;;
        *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || true ;;
    esac
fi

echo "Reincarnation Web: $URL"
wait "$SERVER_PID"
