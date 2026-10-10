#!/usr/bin/env bash
# Milyonuse secrets guard — CLAUDE.md rule 7.
#
# Two checks, both on source alone, no install needed:
#   1. no .env file but .env.example is tracked by git
#   2. browser code reads no server-only variable: in apps/web, only
#      NEXT_PUBLIC_* may appear in a file marked 'use client'. Whatever such a
#      file reads is bundled into JavaScript anyone can download.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0

tracked="$(git ls-files | grep -E '(^|/)\.env(\.|$)' | grep -v '\.env\.example$' || true)"
if [ -n "$tracked" ]; then
  echo "  ✗ environment files are tracked by git:"
  printf '      %s\n' $tracked
  fail=1
fi

if [ -d apps/web/src ]; then
  while IFS= read -r file; do
    if grep -q "^'use client'" "$file"; then
      hits="$(grep -noE "process\.env(\.|\[')[A-Z][A-Z0-9_]*" "$file" | grep -v "NEXT_PUBLIC_" || true)"
      if [ -n "$hits" ]; then
        echo "  ✗ server-only variable read in browser code: $file"
        printf '      %s\n' $hits
        fail=1
      fi
    fi
  done < <(find apps/web/src -name '*.ts' -o -name '*.tsx')
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "guard:secrets — clean"
