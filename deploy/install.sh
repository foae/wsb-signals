#!/usr/bin/env bash
# Install the WSB Signals systemd *user* units so the radar runs unattended and survives restarts.
#
#   ./deploy/install.sh                 # radar + heartbeat timer
#   ./deploy/install.sh --with-dashboard  # also run the Streamlit board as a service
#
# Idempotent: re-run after editing the unit templates in this directory. The units use the venv
# entry points, so `uv sync` must have built .venv first (and after any dependency change).
set -euo pipefail

WSB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$WSB_DIR/deploy"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ ! -x "$WSB_DIR/.venv/bin/wsb" ]]; then
  echo "ERROR: $WSB_DIR/.venv/bin/wsb is missing — run 'uv sync' in $WSB_DIR first." >&2
  exit 1
fi

units=(wsb-signals.service wsb-signals-heartbeat.service wsb-signals-heartbeat.timer)
with_dashboard=0
[[ "${1:-}" == "--with-dashboard" ]] && { units+=(wsb-signals-dashboard.service); with_dashboard=1; }

mkdir -p "$UNIT_DIR"
for u in "${units[@]}"; do
  sed "s#__WSB_DIR__#$WSB_DIR#g" "$SRC/$u" > "$UNIT_DIR/$u"
  echo "installed  $UNIT_DIR/$u"
done

systemctl --user daemon-reload
systemctl --user enable --now wsb-signals.service
systemctl --user enable --now wsb-signals-heartbeat.timer
[[ "$with_dashboard" == 1 ]] && systemctl --user enable --now wsb-signals-dashboard.service

echo
echo "Enabled. Useful commands:"
echo "  status:     systemctl --user status wsb-signals"
echo "  live logs:  journalctl --user -u wsb-signals -f"
echo "  heartbeat:  systemctl --user list-timers wsb-signals-heartbeat.timer"
echo "  stop:       systemctl --user stop wsb-signals      (graceful — SIGTERM)"
echo

# Without linger, user services stop at logout and do NOT start at boot — fatal for a headless daemon.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  echo "NOTE: linger is OFF. To keep the radar running across logout/reboot (needs sudo/polkit):"
  echo "        sudo loginctl enable-linger $USER"
fi
