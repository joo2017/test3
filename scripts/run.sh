#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/kpop_schedule_strong.mjs" "$@"
