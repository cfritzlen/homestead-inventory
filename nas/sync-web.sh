#!/bin/bash
# Auto-sync HTML files from git repo to the web serving directory.
# Run via cron every 2 minutes for near-instant deploys.
#
# Cron entry (add with: crontab -e):
#   */2 * * * * /home/moco/homestead/repo/nas/sync-web.sh >> /home/moco/homestead/sync.log 2>&1

REPO_DIR="/home/moco/homestead/repo"
WEB_DIR="/home/moco/homestead/web"
LOCK="/tmp/sync-web.lock"

# Prevent overlapping runs
if [ -f "$LOCK" ]; then
    exit 0
fi
touch "$LOCK"
trap "rm -f $LOCK" EXIT

cd "$REPO_DIR" || exit 1

# Pull latest from GitHub
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Updating: $LOCAL -> $REMOTE"
git reset --hard origin/main --quiet

# Copy all HTML files and assets to web dir
cp -f *.html "$WEB_DIR/" 2>/dev/null
cp -f *.png *.jpeg "$WEB_DIR/" 2>/dev/null
cp -f *.json "$WEB_DIR/" 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Synced $(ls -1 "$WEB_DIR"/*.html 2>/dev/null | wc -l) HTML files"
