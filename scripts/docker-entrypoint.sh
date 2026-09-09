#!/bin/sh
# Shared Docker entrypoint. Sets GIT_COMMIT_SHA from the build-time stamp
# file when the platform does not provide it at runtime.

GIT_COMMIT_SHA="${GIT_COMMIT_SHA:-$(cat /tmp/git-sha.txt 2>/dev/null || echo "")}"
export GIT_COMMIT_SHA

exec "$@"
