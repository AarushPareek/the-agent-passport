#!/usr/bin/env bash
set -euo pipefail

# Local Agentia quality gates (macOS / Linux).
# Edit this script to match your project. Agentia runs it from the repo root during
# `agentia cicd work test` (local by default) and `agentia cicd work submit` (unless --skip-local-tests).
# The script must exit non-zero if any check fails.

echo "## Running Code Analyzer"
sf code-analyzer run

echo "## Running apex tests (if --apex-test-classes= was specified)"
agentia cicd work test apex -t "${AGENTIA_APEX_TEST_CLASSES:-}" ${AGENTIA_APEX_RERUN_FAILED:-}

echo "## Running LWC tests"
npx sfdx-lwc-jest -- --passWithNoTests
