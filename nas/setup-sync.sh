#!/bin/bash
# One-time setup: clone repo and install cron job for auto-sync.
# Run this on the NAS: bash setup-sync.sh

set -e

REPO_URL="https://github.com/cfritzlen/homestead-inventory.git"
REPO_DIR="/home/moco/homestead/repo"
WEB_DIR="/home/moco/homestead/web"
SYNC_SCRIPT="$REPO_DIR/nas/sync-web.sh"

echo "=== Homestead Web Auto-Sync Setup ==="

# Clone repo if not already there
if [ -d "$REPO_DIR/.git" ]; then
    echo "Repo already exists at $REPO_DIR"
    cd "$REPO_DIR"
    git pull
else
    echo "Cloning repo to $REPO_DIR..."
    git clone "$REPO_URL" "$REPO_DIR"
fi

# Ensure web dir exists
mkdir -p "$WEB_DIR"

# Make sync script executable
chmod +x "$SYNC_SCRIPT"

# Initial sync
echo "Running initial sync..."
cp -f "$REPO_DIR"/*.html "$WEB_DIR/" 2>/dev/null
cp -f "$REPO_DIR"/*.png "$REPO_DIR"/*.jpeg "$WEB_DIR/" 2>/dev/null
cp -f "$REPO_DIR"/*.json "$WEB_DIR/" 2>/dev/null
echo "Copied $(ls -1 "$WEB_DIR"/*.html 2>/dev/null | wc -l) HTML files to $WEB_DIR"

# Add cron job if not already there
CRON_LINE="*/2 * * * * $SYNC_SCRIPT >> /home/moco/homestead/sync.log 2>&1"
if crontab -l 2>/dev/null | grep -q "sync-web.sh"; then
    echo "Cron job already exists"
else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "Added cron job: every 2 minutes"
fi

echo ""
echo "=== Done! ==="
echo "Web files served from: $WEB_DIR"
echo "Auto-sync checks GitHub every 2 minutes"
echo "Sync log: /home/moco/homestead/sync.log"
echo "Test it: http://192.168.1.200:8080/finances.html"
