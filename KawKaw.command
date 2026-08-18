#!/bin/bash
# Double-click to start KawKaw.
#
# Installs dependencies the first time, starts the backend, and opens the page in
# your browser. Closing the Terminal window stops KawKaw.

cd "$(dirname "$0")/src/backend" || exit 1

hold() { echo; echo "Press return to close this window."; read -r; }

if ! command -v node >/dev/null 2>&1; then
  echo "KawKaw needs Node.js, and it is not installed."
  echo "Get the LTS version from https://nodejs.org, then double-click this again."
  hold; exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies. This takes a minute."
  npm install || { echo; echo "Install failed. Check your internet connection."; hold; exit 1; }
fi

echo "Starting KawKaw. Keep this window open; closing it stops KawKaw."
KAWKAW_OPEN=1 exec node server.js
