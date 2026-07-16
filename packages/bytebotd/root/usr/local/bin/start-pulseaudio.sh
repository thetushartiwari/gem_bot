#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/user
export XDG_RUNTIME_DIR=/tmp/pulse-runtime
export PULSE_RUNTIME_PATH=/tmp/pulse-runtime/pulse

mkdir -p "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH" "$HOME/.config/pulse"
chmod 700 "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH"

pulseaudio \
  --daemonize=no \
  --exit-idle-time=-1 \
  --disallow-exit \
  --log-target=stderr \
  --load="module-native-protocol-unix auth-anonymous=1" &
PA_PID=$!

for _ in $(seq 1 40); do
  if pactl info >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if pactl info >/dev/null 2>&1; then
  if ! pactl list short sinks | awk '{print $2}' | grep -qx "bytebot_output"; then
    pactl load-module module-null-sink sink_name=bytebot_output sink_properties=device.description=BytebotOutput >/dev/null
  fi

  pactl set-default-sink bytebot_output >/dev/null 2>&1 || true
  pactl set-default-source bytebot_output.monitor >/dev/null 2>&1 || true
  pactl set-sink-volume bytebot_output 100% >/dev/null 2>&1 || true
fi

wait "$PA_PID"
