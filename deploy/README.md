# Deploy — sewingapp

Rootless podman + systemd-user quadlet (the box's standard app pattern). **No root
steps** — port 8006 is >1024, the printer is reached directly over IPP (no CUPS).

## Install (already done on `command` 2026-06-20)
```bash
cd ~/sewingapp
podman build -t sewingapp .

# 1) container service
cp deploy/sewingapp.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start sewingapp.service     # linger is on → starts at boot

# 2) nightly SQLite backup (03:45, offset from the other apps)
cp deploy/backup.sh ~/.local/bin/sewingapp-backup.sh && chmod +x ~/.local/bin/sewingapp-backup.sh
cp deploy/sewingapp-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sewingapp-backup.timer
```

The Caddy `/sewing/` route and the hub "Sewing" tile are wired in `~/caddy/`
(`Caddyfile` + `dashboard/index.html`). After editing the Caddyfile:
`systemctl --user restart caddy`.

## Config
- `BASE_PATH=/sewing` — set in the quadlet; the app prefixes emitted URLs so the
  same image serves at `/` (dev) and `/sewing/` (proxied).
- `SEWING_PRINTER_URI=ipp://192.168.8.198:631/ipp/print` — the **default** printer.
  The app prefers the value stored in its SQLite `settings` (editable from the
  Settings page); this env is only the seed when none is saved.
- Data: the `sewingdata` named volume holds `sewing.db` (pattern docs + settings).

## Operate
```bash
systemctl --user status sewingapp      # health
podman logs sewingapp                  # app log
systemctl --user restart sewingapp     # after a rebuild
deploy/backup.sh                       # manual backup snapshot
```

## Printer durability
The printer IP is pinned in config. Pin it on the router too — a DHCP reservation
for the printer's MAC `f0:4e:a4:f1:6f:34` → `192.168.8.198` (on 192.168.8.1) keeps
the URI valid across lease changes. If it ever moves, just update the Settings page.
