#!/usr/bin/env bash
#
# Live Shelby round trip — one command.
#
# Starts the official Shelby S3 gateway in a throwaway workspace, runs the
# SealBox integration harness against it, and tears the gateway down again.
#
# The harness exits non-zero unless every stage succeeds: fixture, seal,
# upload over the network, download over the network, SHA-256 equality,
# Ed25519 verification, signer-identity verification and local tamper
# rejection. This script never reports "uploaded" as "verified".
#
# Required (fails closed, with the exact name to export):
#   SHELBY_GW_API_KEY        the Shelby API key from https://geomi.dev
#
# Optional:
#   SHELBY_GW_ACCESS_KEY_ID  local S3 access key id (generated if unset)
#   SHELBY_GW_SECRET_ACCESS_KEY  local S3 secret (generated if unset)
#   SHELBY_GW_APTOS_PRIVATE_KEY   Aptos key (read from ~/.shelby/config.yaml)
#   SHELBY_GW_ACCOUNT        account name in ~/.shelby/config.yaml
#   SHELBY_GW_PORT           gateway port (default 9000)
#   SHELBY_GW_RPC_ENDPOINT    upstream RPC base URL
#   SHELBY_NETWORK            default shelbynet
#
# No secret is ever printed, and no secret is written into the repository:
# the gateway workspace is a temporary directory and the configuration reads
# every credential from the environment.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_VERSION="${SHELBY_GATEWAY_VERSION:-1.12.1}"
PORT="${SHELBY_GW_PORT:-9000}"
NETWORK="${SHELBY_NETWORK:-shelbynet}"
ACCOUNT="${SHELBY_GW_ACCOUNT:-parzi}"

if [ -z "${SHELBY_GW_API_KEY:-}" ]; then
  cat >&2 <<'MSG'
SHELBY API KEY REQUIRED

  export SHELBY_GW_API_KEY="$(read -rs SHELBY_GW_API_KEY && echo)"

Obtain the key at https://geomi.dev -> "API Resource" -> network "Shelbynet".
It must be exported BEFORE the gateway starts: the gateway reads its
configuration at start-up, so it must be restarted after the key is set.

MSG
  exit 2
fi

echo "Shelby API key: PRESENT"

# The S3 signing secrets are operator-chosen and local to this host's own
# gateway; they are never issued by Shelby.
if [ -z "${SHELBY_GW_ACCESS_KEY_ID:-}" ]; then
  SHELBY_GW_ACCESS_KEY_ID="sealbox-local-gateway"
fi
if [ -z "${SHELBY_GW_SECRET_ACCESS_KEY:-}" ]; then
  SHELBY_GW_SECRET_ACCESS_KEY="$(head -c 40 /dev/urandom | base64 | tr -d '\n=+/' | head -c 40)"
fi

# The Aptos key signs the on-chain blob-commitment registration.
if [ -z "${SHELBY_GW_APTOS_PRIVATE_KEY:-}" ]; then
  if [ ! -f "${HOME}/.shelby/config.yaml" ]; then
    echo "Set SHELBY_GW_APTOS_PRIVATE_KEY (no ~/.shelby/config.yaml found)." >&2
    exit 2
  fi
  SHELBY_GW_APTOS_PRIVATE_KEY="$(python3 -c "
import os, yaml
d = yaml.safe_load(open(os.path.expanduser('~/.shelby/config.yaml')))
print(d['accounts']['${ACCOUNT}']['private_key'])
")"
fi
export SIGNER_PRIVATE_KEY="${SIGNER_PRIVATE_KEY:-$SHELBY_GW_APTOS_PRIVATE_KEY}"

WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/sealbox-gw-XXXXXX")"
GATEWAY_PID=""

cleanup() {
  if [ -n "${GATEWAY_PID}" ]; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORKSPACE}"
}
trap cleanup EXIT

echo "Preparing the official S3 gateway in a temporary workspace..."
( cd "${WORKSPACE}" \
  && npm init -y >/dev/null 2>&1 \
  && npm install --silent --no-save "@shelby-protocol/s3-gateway@${GATEWAY_VERSION}" >/dev/null 2>&1 )
cp "${REPO_ROOT}/docs/shelby-gateway.config.example.js" "${WORKSPACE}/shelby.config.js"

export SHELBY_GW_ACCESS_KEY_ID
export SHELBY_GW_SECRET_ACCESS_KEY
export SHELBY_GW_APTOS_PRIVATE_KEY
export SHELBY_GW_API_KEY
export SHELBY_GW_PORT="${PORT}"
export SHELBY_GW_LOCATION_HINT="${SHELBY_GW_LOCATION_HINT:-shelbynet-1}"

echo "Starting the S3 gateway on port ${PORT}..."
# `exec` replaces the subshell with node, so $! is the gateway's own PID and
# the trap below can actually stop it.
( cd "${WORKSPACE}" \
  && exec node node_modules/@shelby-protocol/s3-gateway/bin/entry.js \
       --config ./shelby.config.js > "${WORKSPACE}/gateway.log" 2>&1 ) &
GATEWAY_PID=$!

for _ in $(seq 1 40); do
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
  echo "The S3 gateway did not start. Log tail:" >&2
  tail -20 "${WORKSPACE}/gateway.log" >&2 || true
  exit 1
fi

echo "Running the SealBox live harness..."
cd "${REPO_ROOT}"
SHELBY_S3_ENDPOINT="http://localhost:${PORT}" \
SHELBY_S3_REGION="${SHELBY_S3_REGION:-shelbyland}" \
SHELBY_S3_ACCESS_KEY_ID="${SHELBY_GW_ACCESS_KEY_ID}" \
SHELBY_S3_SECRET_ACCESS_KEY="${SHELBY_GW_SECRET_ACCESS_KEY}" \
SHELBY_API_KEY="${SHELBY_GW_API_KEY}" \
SHELBY_NETWORK="${NETWORK}" \
npm run integration:shelby
