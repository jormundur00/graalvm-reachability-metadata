#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <groupId:artifactId:version>"
    exit 1
fi

GAV="$1"
IFS=':' read -r GROUP ARTIFACT VERSION <<< "$GAV"

INDEX_FILE="metadata/$GROUP/$ARTIFACT/index.json"

if [ ! -f "$INDEX_FILE" ]; then
    echo "Library $GAV is NOT supported by the GraalVM Reachability Metadata repository."
    exit 1
fi

FOUND=$(
    awk -v ver="$VERSION" '
      /"tested-versions"[[:space:]]*:/ {inside=1; next}
      inside && /\]/ {inside=0}
      inside && $0 ~ "\"" ver "\"" {print "yes"}
    ' "$INDEX_FILE"
)

if [ "$FOUND" = "yes" ]; then
    echo "Library $GAV is supported by the GraalVM Reachability Metadata repository.️"
else
    echo "Library $GAV is NOT supported by the GraalVM Reachability Metadata repository."
fi
