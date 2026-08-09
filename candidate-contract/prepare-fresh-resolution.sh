#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f Cargo.toml ]]; then
  echo "prepare-fresh-resolution.sh must run from the candidate repository root" >&2
  exit 2
fi

if [[ -f Cargo.lock ]]; then
  historical_lock_sha="$(sha256sum Cargo.lock | awk '{print $1}')"
  {
    echo "Historical Cargo.lock SHA-256: \`${historical_lock_sha}\`"
    echo
    echo "The immutable source checkout was verified before this helper moved the historical lockfile aside. The generated lockfile below is execution evidence only and is never committed to the candidate branch."
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  mv Cargo.lock "${RUNNER_TEMP:-/tmp}/dpm-historical-Cargo.lock"
fi

export CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
cargo generate-lockfile
