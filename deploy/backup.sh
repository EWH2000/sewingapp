#!/usr/bin/env bash
# Consistent snapshot of the sewingapp SQLite database to a host-owned folder.
# Uses SQLite's online backup API (safe while the app is writing). Keeps newest $KEEP.
#   Run manually:          deploy/backup.sh
#   Run daily via systemd:  sewingapp-backup.timer
set -euo pipefail

CONTAINER="${SEWING_CONTAINER:-sewingapp}"
BACKUP_DIR="${SEWING_BACKUP_DIR:-$HOME/.local/share/sewingapp/backups}"
KEEP="${SEWING_BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
dest="$BACKUP_DIR/sewing-$ts.db"

# 1) Consistent snapshot inside the volume via SQLite online backup.
podman exec "$CONTAINER" python -c \
    "import sqlite3; s=sqlite3.connect('/data/sewing.db'); d=sqlite3.connect('/data/.snapshot.db'); s.backup(d); d.close(); s.close()"
# 2) Copy it out to the host (owned by you, easy to copy offsite).
podman cp "$CONTAINER:/data/.snapshot.db" "$dest"
# 3) Drop the in-volume temp copy.
podman exec "$CONTAINER" rm -f /data/.snapshot.db
# 4) Prune to the newest $KEEP.
ls -1t "$BACKUP_DIR"/sewing-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f || true

echo "backup written: $dest"
