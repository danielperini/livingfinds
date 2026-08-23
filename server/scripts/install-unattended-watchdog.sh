#!/usr/bin/env bash
set -euo pipefail
ROOT="${ROOT:-/opt/livingfinds}"
WATCH="$ROOT/server/scripts/unattended-watchdog.sh"
chmod 750 "$WATCH" "$ROOT/server/scripts/run-sales-engine-now.sh"
cat >/etc/systemd/system/livingfinds-unattended-watchdog.service <<EOF
[Unit]
Description=Living Finds unattended AI/Ads watchdog
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$WATCH
TimeoutStartSec=600
EOF
cat >/etc/systemd/system/livingfinds-unattended-watchdog.timer <<'EOF'
[Unit]
Description=Run Living Finds unattended watchdog every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=30s
Persistent=true
Unit=livingfinds-unattended-watchdog.service

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now livingfinds-unattended-watchdog.timer
systemctl start livingfinds-unattended-watchdog.service || true
systemctl status livingfinds-unattended-watchdog.timer --no-pager
