#!/usr/bin/env bash
set -euo pipefail

# CrateUp Standalone Python Runtime Setup (Apple Silicon)
# Downloads relocatable standalone CPython 3.12 and installs dependencies.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/python-runtime"
PYTHON_BIN="${RUNTIME_DIR}/bin/python3"
REQUIREMENTS="${ROOT_DIR}/python-sidecar/requirements.txt"

RELEASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz"

echo "=== Checking CrateUp Python Runtime ==="

if [ -x "${PYTHON_BIN}" ]; then
  if "${PYTHON_BIN}" -c "import shazamio, deemix" >/dev/null 2>&1; then
    echo "Python runtime is already set up and verified at: ${RUNTIME_DIR}"
    exit 0
  fi
  echo "Existing Python runtime found but requirements not verified. Reinstalling requirements..."
else
  echo "Downloading standalone CPython 3.12 for macOS (Apple Silicon)..."
  TMP_ARCHIVE="$(mktemp -t cpython-standalone.XXXXXX).tar.gz"
  curl -fsSL -o "${TMP_ARCHIVE}" "${RELEASE_URL}"

  echo "Extracting runtime to ${RUNTIME_DIR}..."
  rm -rf "${RUNTIME_DIR}"
  mkdir -p "${RUNTIME_DIR}"
  tar -xzf "${TMP_ARCHIVE}" -C "${RUNTIME_DIR}" --strip-components=1
  rm -f "${TMP_ARCHIVE}"
fi

echo "Installing sidecar dependencies from ${REQUIREMENTS}..."
"${PYTHON_BIN}" -m pip install --upgrade pip
"${PYTHON_BIN}" -m pip install -r "${REQUIREMENTS}"

echo "Cleaning up __pycache__ directories..."
find "${RUNTIME_DIR}" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "Verifying runtime environment..."
"${PYTHON_BIN}" -c "import shazamio, deemix; print('✓ Python runtime successfully verified!')"
