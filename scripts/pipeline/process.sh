#!/bin/zsh
# As each scrape logged in <log-dir> finishes, builds, embeds, drops copies,
# tags and uploads its site, then verifies it in R2 and deletes the local
# copies. Registration (register-rows.mjs + SQL) and the search index are done
# afterwards.
#
#   scripts/pipeline/process.sh <log-dir> name ...   (the names given to queue.sh)
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.." || exit 1
export FFMPEG=${FFMPEG:-/Users/henryallan/Documents/toolbox/vendor/ffmpeg/darwin-arm64/ffmpeg}
LOGS=$1; shift
DONE=$LOGS/.processed; touch $DONE
remaining() { for n in "$@"; do grep -qx "$n" $DONE || echo $n; done; }
while [ -n "$(remaining "$@")" ]; do
  for n in $(remaining "$@"); do
    log=$LOGS/$n.log
    [ -f $log ] || continue
    if tr '\r' '\n' < $log | grep -q "videos on "; then
      dir=$(tr '\r' '\n' < $log | grep -oE "media/scraped/[^/ ]+/scrape.json" | head -1 | xargs dirname)
      echo "== $n ($dir) $(date '+%H:%M')"
      if [ -n "$dir" ]; then
        node scripts/build-proxies.ts --in $dir --merge 2>&1 | tr '\r' '\n' | grep -E "assets in|rror" | tail -1
        node scripts/embed.ts 2>&1 | tr '\r' '\n' | grep -E "embedded|rror" | tail -1
        node $HERE/dupes.mjs $(basename $dir) --apply 2>&1 | grep -E "copies|rror" | tail -1
        node scripts/embed.ts 2>&1 | tr '\r' '\n' | grep -E "^index|rror" | tail -1
        node scripts/tag.ts 2>&1 | tr '\r' '\n' | grep -E "tagged in|rror" | tail -1
        node --env-file=.env.local scripts/upload-library.ts 2>&1 | tr '\r' '\n' | grep -E "MB →|rror" | tail -2
        node $HERE/prune.mjs --delete 2>&1 | grep -E "proxies:|deleted" | tail -2
      fi
      echo $n >> $DONE
    elif ! pgrep -f "scrape.ts .*$(tr '\r' '\n' < $log | head -1 | sed -E 's#scraping https?://(www\.)?##')" >/dev/null && [ $(( $(date +%s) - $(stat -f %m $log) )) -gt 600 ]; then
      echo "== $n ended without a result; skipped"; echo $n >> $DONE
    fi
  done
  sleep 60
done
df -h / | tail -1 | awk '{print $4" free"}'
