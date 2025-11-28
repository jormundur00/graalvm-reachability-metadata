#!/usr/bin/env bash
set -euo pipefail

BASE_REF="$1"
FILTERS_YAML="$2"

# Get changed files since BASE_REF
CHANGED_FILES=$(git diff --name-only "$BASE_REF" HEAD)

# Parse YAML-style filters
current_filter=""
declare -A outputs

while IFS= read -r line; do
  # Trim leading/trailing spaces
  line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  # Skip empty lines
  [[ -z "$line" ]] && continue

  if [[ "$line" =~ ^[^-][^:]*:$ ]]; then
    # This is a filter name
    current_filter="${line%:}"
    outputs[$current_filter]=false
  elif [[ "$line" =~ ^- ]]; then
    # This is a pattern under current filter
    pattern="${line#- }"
    pattern="${pattern//\*\*/.*}"  # convert ** to regex
    if echo "$CHANGED_FILES" | grep -E "^$pattern$" >/dev/null; then
      outputs[$current_filter]=true
    fi
  fi
done <<< "$FILTERS_YAML"

# Export outputs
for f in "${!outputs[@]}"; do
  echo "$f=${outputs[$f]}" >> $GITHUB_OUTPUT
done
