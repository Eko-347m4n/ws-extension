#!/bin/bash
# This script runs the Electron app for native messaging using absolute paths.

LOG_FILE="/tmp/ws_host_log.txt"
echo "Host script started at $(date)" > "$LOG_FILE"

# Define absolute paths to avoid any ambiguity
APP_DIR="/home/b47m4n/ekstensi chrome/ws-extension/desktop-app"
ELECTRON_EXEC="/home/b47m4n/ekstensi chrome/ws-extension/desktop-app/node_modules/.bin/electron"

# Check if the Electron executable exists
if [ ! -f "$ELECTRON_EXEC" ]; then
    echo "ERROR: Electron executable not found at $ELECTRON_EXEC" >> "$LOG_FILE"
    exit 1
fi

echo "Executing Electron: $ELECTRON_EXEC with app path: $APP_DIR" >> "$LOG_FILE" 2>&1

# Execute Electron by passing the app directory as an argument, avoiding 'cd'.
# Redirect stderr to the log file, but let stdout go to the native messaging host.
exec "$ELECTRON_EXEC" "$APP_DIR" --no-sandbox <&0 2>> "$LOG_FILE"

echo "Electron process finished at $(date). Exit code: $?" >> "$LOG_FILE" 2>&1
