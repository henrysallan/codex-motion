#!/bin/zsh
# Scrapes a list of sites two at a time (counting scrapes of ours already
# running), robots.txt ignored at Henry's request. TURNS sets the agent's turn
# budget (default 20). Each site logs to <log-dir>/<name>.log; log-dir is
# relative to the repo root.
#
#   scripts/pipeline/queue.sh <log-dir> "https://studio.example/work name" ...
cd "$(dirname "$0")/../.." || exit 1
export FFMPEG=${FFMPEG:-/Users/henryallan/Documents/toolbox/vendor/ffmpeg/darwin-arm64/ffmpeg}
LOGS=$1; shift
mkdir -p "$LOGS"
running() { pgrep -f "scripts/scrape.ts .*--agent-turns" | wc -l | tr -d ' '; }
for entry in "$@"; do
  url=${entry% *}; name=${entry#* }
  while [ "$(running)" -ge 2 ]; do sleep 15; done
  echo "start $name $(date '+%H:%M')"
  node scripts/scrape.ts "$url" --max-pages 300 --agent-turns ${TURNS:-20} --ignore-robots > "$LOGS/$name.log" 2>&1 &
  sleep 5
done
wait
while [ "$(running)" -gt 0 ]; do sleep 15; done
for entry in "$@"; do name=${entry#* }; echo "== $name"; tr '\r' '\n' < "$LOGS/$name.log" | grep -E "^  (static|render|enrich|agent   |framerate)|videos on|found by" | grep -v "^          "; done
