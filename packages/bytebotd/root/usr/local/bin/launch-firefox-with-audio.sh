#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/user
export DISPLAY=:0
export XDG_RUNTIME_DIR=/tmp/pulse-runtime
export PULSE_RUNTIME_PATH=/tmp/pulse-runtime/pulse
export PULSE_SERVER=unix:/tmp/pulse-runtime/pulse/native

wait_for_window() {
  local class_name="$1"
  local attempts=0

  while [ "$attempts" -lt 40 ]; do
    local window_id
    window_id="$(sudo -u user wmctrl -lx 2>/dev/null | awk -v class_name="$class_name" '$0 ~ class_name { print $1 }' | tail -n 1)"
    if [ -n "${window_id}" ]; then
      sudo -u user wmctrl -i -a "${window_id}" >/dev/null 2>&1 || true
      sudo -u user wmctrl -i -r "${window_id}" -b add,maximized_vert,maximized_horz >/dev/null 2>&1 || true
      sudo -u user wmctrl -i -r "${window_id}" -b add,fullscreen >/dev/null 2>&1 || true
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.25
  done

  return 1
}

/usr/bin/firefox-esr --new-window "$@" &
FIREFOX_PID=$!
wait_for_window 'firefox-esr.Firefox-esr' || true
wait "${FIREFOX_PID}"
