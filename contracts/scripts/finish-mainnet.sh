#!/usr/bin/env bash
# After launch-mainnet.sh: hand the protocol to its owner and open it.
#
#   bash scripts/finish-mainnet.sh                         # from contracts/ — OWNER = contracts/.env.owner
#   bash scripts/finish-mainnet.sh 0x<OWNER address>      # another wallet (a Safe, a hardware wallet…)
#
# OWNER becomes the only proposer/executor of the 48h timelock that owns
# every contract. If nobody can sign for it, admin powers are gone for good —
# so control of it must be PROVEN: either its key is the one in
# contracts/.env.owner, or it has already sent a transaction on Base.
#
# Roles after this script:
#   admin    = the timelock (OWNER schedules, waits 48h in public, executes)
#   operator = the deployer hot key: reply budgets, legs, deposit caps,
#              rebalancing between the protocol's own vaults, unpause
#   guardian = the deployer hot key: pause, veto a scheduled admin change
# Neither hot role can withdraw funds or rewire the protocol.
#
# Steps: hand-over on every chain, status, then the launch deposit caps
# (default 25,000 USDC per vault). Resumable.
set -euo pipefail
cd "$(dirname "$0")/.."

# the address of the owner wallet kept in contracts/.env.owner, if any —
# derived from its private key, never trusted from the OWNER_ADDRESS line
LOCAL_OWNER=""
if [[ -f .env.owner ]]; then
  LOCAL_OWNER=$(node -e "
const fs=require('fs');const {Wallet}=require('ethers');
const m=fs.readFileSync('.env.owner','utf8').match(/^OWNER_PK=(0x[0-9a-fA-F]{64})/m);
if(m)process.stdout.write(new Wallet(m[1]).address)")
fi

OWNER="${1:-$LOCAL_OWNER}"
if [[ ! "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "usage: bash scripts/finish-mainnet.sh [0x<OWNER address>]   (default: the wallet in contracts/.env.owner)"
  exit 1
fi

export SPAWN_PROFILE=mainnet
export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
NETS=(base optimism arbitrum)
LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-25000}"

HOT=$(node -e "
const fs=require('fs');const {Wallet}=require('ethers');
const m=fs.readFileSync('.env','utf8').match(/DEPLOYER_PK=(0x[0-9a-fA-F]{64})/);
if(!m){console.error('DEPLOYER_PK missing in contracts/.env');process.exit(1)}
process.stdout.write(new Wallet(m[1]).address)")

# Proof of control. Holding the key is proof; otherwise the owner must have
# signed at least one transaction on Base — an address that has never sent
# anything may be a custodial (exchange) deposit address.
lower() { echo "$1" | tr 'A-F' 'a-f'; }
if [[ -n "$LOCAL_OWNER" && "$(lower "$OWNER")" == "$(lower "$LOCAL_OWNER")" ]]; then
  echo "✓ OWNER $OWNER is the wallet in contracts/.env.owner (key held on this machine)"
else
  NONCE=$(node -e "
const {ethers}=require('ethers');
new ethers.JsonRpcProvider('https://mainnet.base.org').getTransactionCount('$OWNER').then(n=>process.stdout.write(String(n)))")
  if [[ "$NONCE" == "0" ]]; then
    echo "✗ $OWNER has never sent a transaction on Base — control of it is not proven."
    echo "  Send any transaction FROM that wallet on Base first, then run this again."
    exit 1
  fi
  echo "✓ OWNER $OWNER has signed $NONCE transaction(s) on Base"
fi

step() { printf '\n════════ %s ════════\n' "$*"; }

step "hand-over — OWNER $OWNER · operator/guardian $HOT"
for n in "${NETS[@]}"; do
  echo "→ $n"
  SPAWN_OWNER="$OWNER" SPAWN_OPERATOR="$HOT" SPAWN_GUARDIAN="$HOT" \
    npx hardhat run scripts/handover.js --network "$n" 2>&1 | tee /dev/stderr | grep -q 'hand-over complete' \
    || { echo "✗ hand-over did not complete on $n — re-run this script (it resumes)"; exit 1; }
done

step "status"
npx hardhat run scripts/status.js

step "launch deposit caps — $LAUNCH_CAP USDC per vault"
for n in "${NETS[@]}"; do
  SPAWN_APPLY=1 SPAWN_CAP_USDC="$LAUNCH_CAP" npx hardhat run scripts/set-cap.js --network "$n"
done

cat <<'EOF'

════════ HANDED OVER AND OPEN ════════
Every contract answers to the owner's 48h timelock; the hot key only tunes.
Next: publish the site with public/onchain/mainnet.json.
EOF
