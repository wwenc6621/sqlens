#!/usr/bin/env bash
# Bundle and run every driver integration script against locally running
# databases (used by CI service containers, and handy locally).
#
#   ./scripts/run-integration.sh            # all suites
#   ./scripts/run-integration.sh test-mssql # one suite
#
# Credentials are read from the environment with the same defaults the CI
# services use (SQLENS_CH_PASSWORD, SQLENS_MSSQL_PASSWORD).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(test-elasticsearch test-mongodb test-clickhouse test-mssql test-p4)
fi

BUNDLE_ARGS=(
  --bundle --platform=node --format=cjs
  --external:better-sqlite3 --external:sql.js --external:cpu-features "--external:*.node"
  --alias:vscode=./src/shims/vscode.ts
  --alias:apache-arrow/Arrow.node=./src/shims/apache-arrow.ts
)

failed=0
for suite in "${SUITES[@]}"; do
  printf '%-20s ' "$suite"
  if ! npx esbuild "scripts/$suite.ts" "${BUNDLE_ARGS[@]}" --outfile="/tmp/$suite.cjs" >/dev/null 2>&1; then
    echo "BUNDLE FAILED"
    failed=1
    continue
  fi
  if out=$(node "/tmp/$suite.cjs" 2>&1 | grep -v '^\[' | tail -1); then
    echo "$out"
    case "$out" in
      "ALL OK") ;;
      *) failed=1 ;;
    esac
  else
    echo "RUN FAILED"
    failed=1
  fi
done

exit "$failed"
