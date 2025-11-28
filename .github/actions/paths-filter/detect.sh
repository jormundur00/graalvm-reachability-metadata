#!/usr/bin/env bash
set -euo pipefail

# Always use the PR base SHA as the comparison
BASE_REF="${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:-origin/master}"

FILTERS_YAML="$1"

# Get changed files since the base commit
CHANGED_FILES=$(git diff --name-only "$BASE_REF" HEAD)

# Parse filters and produce outputs (same as before)
current_filter=""
declare -A outputs

while IFS= read -r line; do
  # Trim spaces
  line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [[ -z "$line" ]] && continue

  if [[ "$line" =~ ^[^-][^:]*:$ ]]; then
    current_filter="${line%:}"
    outputs[$current_filter]=false
  elif [[ "$line" =~ ^- ]]; then
    pattern="${line#- }"
    pattern="${pattern//\*\*/.*}"  # convert ** to regex
    pattern="${pattern//\*/.*}"    # convert * to regex
    if echo "$CHANGED_FILES" | grep -E "^$pattern$" >/dev/null; then
      outputs[$current_filter]=true
    fi
  fi
done <<< "$FILTERS_YAML"

# Export outputs
for f in "${!outputs[@]}"; do
  echo "$f=${outputs[$f]}" >> $GITHUB_OUTPUT
done
