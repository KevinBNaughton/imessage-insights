#!/bin/sh
# Runs the HTTP server (REST API + POST /mcp) at login and restarts it if it exits.
#
#   scripts/launch-agent.sh install    write the LaunchAgent and start it (re-run after changing Node versions)
#   scripts/launch-agent.sh uninstall  stop it and remove the LaunchAgent
#
# Logs: ~/Library/Logs/imessage-insights.log
set -eu

LABEL="com.imessage-insights.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/imessage-insights.log"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
install)
    # The real node binary, not a version-manager shim: launchd doesn't load your shell setup.
    NODE="$(node -p process.execPath)"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>--env-file-if-exists=.env</string>
        <string>src/server.ts</string>
    </array>
    <key>WorkingDirectory</key><string>$REPO</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Started $LABEL ($NODE). Logs: $LOG"
    ;;
uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
*)
    echo "Usage: $0 install|uninstall" >&2
    exit 1
    ;;
esac
