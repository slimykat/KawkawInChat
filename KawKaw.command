#!/bin/bash
# Double-click to start KawKaw.
#
# Installs dependencies the first time, starts the backend, and opens the page in
# your browser. Closing this window stops KawKaw — but a window that is force-quit
# can leave the backend running behind it, so a second double-click looks for one
# that is already up and opens that instead of failing next to it.

cd "$(dirname "$0")/src/backend" || exit 1

hold() { echo; echo "Press return to close this window."; read -r; }

# Finder runs this without a login shell, so PATH is whatever path_helper gives
# and nothing else — nvm and Apple Silicon Homebrew are both invisible, and Node
# looks missing to someone who has it. Look where it actually lives first.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "KawKaw needs Node.js, and it is not installed."
  echo "Get the LTS version from https://nodejs.org, then double-click this again."
  echo
  echo "Already have it? If you installed Node with nvm, a double-click cannot see"
  echo "it. Open Terminal, cd to this folder, and run:  ./KawKaw.command"
  hold; exit 1
fi

# Not [ -d node_modules ]: an interrupted install leaves the directory in place
# but half-empty, and the only symptom is a stack trace about a missing module.
if ! node -e "require.resolve('ws'); require.resolve('dotenv')" >/dev/null 2>&1; then
  echo "Installing dependencies. This takes a minute."
  # --omit=dev keeps nodemon out of a streamer's install: it is only used by
  # `npm run dev`, and pulling it in is what makes npm report a vulnerability on
  # an otherwise two-package install.
  npm install --omit=dev --no-fund --no-audit \
    || { echo; echo "Install failed. Check your internet connection."; hold; exit 1; }
fi

echo "Starting KawKaw. Keep this window open; closing it stops KawKaw."
# Not exec: the script has to outlive node so a startup failure can hold the
# window open, instead of leaving a stack trace as the last thing on screen.
KAWKAW_OPEN=1 node server.js
status=$?

# 2 means the backend already said what was wrong, in words a streamer can act on.
# 3 means a KawKaw was already running and the browser has been sent to it — nothing
# is wrong, so nothing more is said here.
# 130 is Ctrl-C and 143 is a kill — the streamer stopping it on purpose.
if [ $status -eq 2 ]; then
  hold
elif [ $status -ne 0 ] && [ $status -ne 3 ] && [ $status -ne 130 ] && [ $status -ne 143 ]; then
  echo
  echo "KawKaw stopped unexpectedly."
  hold
fi
