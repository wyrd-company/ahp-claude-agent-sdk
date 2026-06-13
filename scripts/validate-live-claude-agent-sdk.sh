#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv "$ROOT_DIR/.env"

export CLAUDE_AGENT_SDK_LIVE_TURN_PROMPT=${CLAUDE_AGENT_SDK_LIVE_TURN_PROMPT:-Reply with exactly: pong}

cd "$ROOT_DIR"
npm run build
node --test --import tsx test/live-claude-agent-sdk.test.ts
