#!/bin/bash
# This script runs the Electron app for native messaging.

# The path to the directory where your Electron app is located.
APP_DIR="/home/b47m4n/ekstensi chrome/ws-extension/desktop-app"

# Navigate to the app directory and start the app.
cd "$APP_DIR" || exit

# It's good practice to use the locally installed electron version.
./node_modules/.bin/electron . --no-sandbox