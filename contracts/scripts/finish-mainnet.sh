#!/usr/bin/env bash
# After launch-mainnet.sh: hand the protocol to its owner and open it.
#
#   bash scripts/finish-mainnet.sh                         # from contracts/ — OWNER = contracts/.env.owner
#   bash scripts/finish-mainnet.sh 0x<OWNER address>      # another wallet (a Safe, a hardware wallet…)
#
# OWNER becomes the only proposer/executor of the 48h timelock that owns
# every contract. If nobody can sign for it, admin powers are gone for good —
# so control of it must be PROVEN: either its key is the one in
# contracts/.env.owner, or it has already sent a transaction on the hub chain.
#
# Roles after this script:
#   admin    = the timelock (OWNER schedules, waits 48h in public, executes)
#   operator = the deployer hot key: reply budgets, legs, deposit caps,
#              rebalancing between the protocol's own vaults, unpause
#   guardian = the deployer hot key: pause, veto a scheduled admin change
# Neither hot role can withdraw funds or rewire the protocol.
#
# Steps: a canary round trip from the second spoke (the launch script only
# crossed from the first), the hand-over on every chain, status, then the
# launch deposit caps (default 25,000 USDC per vault). Resumable: finished
# steps are skipped or send nothing.
#
# SPAWN_LAUNCH_PROFILE=testnet rehearses this very script on the testnets.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${SPAWN_LAUNCH_PROFILE:-mainnet}"
export SPAWN_PROFILE="$PROFILE"
if [[ "$PROFILE" == "mainnet" ]]; then
  NETS="base optimism arbitrum"
  HUB_RPC="https://mainnet.base.org"
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
  SMOKE_ENV="SMOKE_BUY_USDC=3"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-25000}"
elif [[ "$PROFILE" == "testnet" ]]; then
  NETS="baseSepolia optimismSepolia arbitrumSepolia"
  HUB_RPC="https://sepolia.base.org"
  SMOKE_ENV="SPAWN_REHEARSAL=1"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-500000000}"
else
  echo "unknown SPAWN_LAUNCH_PROFILE \"$PROFILE\" (mainnet | testnet)"; exit 1
fi
set -- $NETS
SPOKE_B="$3"
LOG_DIR="deployments/logs"
mkdir -p "$LOG_DIR"

# the address of the owner wallet kept in contracts/.env.owner, if any —
# derived from its private key, never trusted from the OWNER_ADDRESS line
LOCAL_OWNER=""
if [[ -f .env.owner ]]; then
  LOCAL_OWNER=$(node -e "
const fs=require('fs');const {Wallet}=require('ethers');
const m=fs.readFileSync('.env.owner','utf8').match(/^OWNER_PK=(0x[0-9a-fA-F]{64})/m);
if(m)process.stdout.write(new Wallet(m[1]).address)")
fi

OWNER="${SPAWN_FINISH_OWNER:-$LOCAL_OWNER}"
if [[ ! "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "no owner: create contracts/.env.owner or set SPAWN_FINISH_OWNER=0x<address>"
  exit 1
fi

HOT=$(node -e "
const fs=require('fs');const {Wallet}=require('ethers');
const m=fs.readFileSync('.env','utf8').match(/DEPLOYER_PK=(0x[0-9a-fA-F]{64})/);
if(!m){console.error('DEPLOYER_PK missing in contracts/.env');process.exit(1)}
process.stdout.write(new Wallet(m[1]).address)")

# Proof of control. Holding the key is proof; otherwise the owner must have
# signed at least one transaction on the hub chain — an address that has
# never sent anything may be a custodial (exchange) deposit address.
lower() { echo "$1" | tr 'A-F' 'a-f'; }
if [[ -n "$LOCAL_OWNER" && "$(lower "$OWNER")" == "$(lower "$LOCAL_OWNER")" ]]; then
  echo "✓ OWNER $OWNER is the wallet in contracts/.env.owner (key held on this machine)"
else
  NONCE=$(node -e "
const {ethers}=require('ethers');
new ethers.JsonRpcProvider('$HUB_RPC').getTransactionCount('$OWNER').then(n=>process.stdout.write(String(n)))")
  if [[ "$NONCE" == "0" ]]; then
    echo "✗ $OWNER has never sent a transaction on the hub chain — control of it is not proven."
    echo "  Send any transaction FROM that wallet there first, then run this again."
    exit 1
  fi
  echo "✓ OWNER $OWNER has signed $NONCE transaction(s) on the hub chain"
fi

step() { printf '\n════════ %s ════════\n' "$*"; }
# logged <label> <success-regex> <command…> — output kept in a log file,
# success = exit 0 AND the line that proves it. LOG_TRIES attempts (default
# 1): the hand-over and the caps are idempotent and resume, so a network
# blip or a lagging node is retried; a canary is never repeated by itself.
logged() {
  local label="$1" ok="$2"; shift 2
  local try tries="${LOG_TRIES:-1}" log
  for try in $(seq 1 "$tries"); do
    log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-$(echo "$label" | tr -c 'A-Za-z0-9\n' '_').log"
    echo "→ $label (attempt $try of $tries)"
    if "$@" > "$log" 2>&1 && grep -Eq "$ok" "$log"; then
      tail -n 8 "$log"
      echo "✓ $label"
      return 0
    fi
    tail -n 16 "$log" | cut -c1-240
    if [[ "$try" != "$tries" ]]; then echo "… not clean; resuming in 20s"; sleep 20; fi
  done
  echo "✗ $label did not finish cleanly — stopping. Full output: contracts/$log"
  echo "  (this script resumes: fix the cause and run the same command again)"
  exit 1
}

# The launch script's canary crossed from the first spoke; the second has
# only been deployed and configured. Prove its pathway with real money
# before anything is handed over or opened.
CANARY_MARK="deployments/.canary-$PROFILE-$SPOKE_B.ok"
if [[ -f "$CANARY_MARK" ]]; then
  step "canary from $SPOKE_B — already passed ($(cat "$CANARY_MARK"))"
else
  step "canary — a full round trip from $SPOKE_B (the deployer's own money)"
  logged "canary $SPOKE_B (cross-chain)" '🎉' env "$SMOKE_ENV" npx hardhat run scripts/smoke.js --network "$SPOKE_B"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$CANARY_MARK"
fi

step "hand-over — OWNER $OWNER · operator/guardian $HOT"
for n in $NETS; do
  LOG_TRIES=4 logged "hand-over $n" 'hand-over complete' \
    env SPAWN_OWNER="$OWNER" SPAWN_OPERATOR="$HOT" SPAWN_GUARDIAN="$HOT" npx hardhat run scripts/handover.js --network "$n"
done

step "status"
npx hardhat run scripts/status.js

step "launch deposit caps — $LAUNCH_CAP USDC per vault"
for n in $NETS; do
  LOG_TRIES=4 logged "set-cap $n" 'already set|setDepositCap\(' \
    env SPAWN_APPLY=1 SPAWN_CAP_USDC="$LAUNCH_CAP" npx hardhat run scripts/set-cap.js --network "$n"
done

step "status"
npx hardhat run scripts/status.js

if [[ "$PROFILE" == "mainnet" ]]; then
  cat <<'EOF'

════════ HANDED OVER AND OPEN ════════
Every contract answers to the owner's 48h timelock; the hot key only tunes.
Next: publish the site with public/onchain/mainnet.json.
EOF
else
  printf '\n════════ REHEARSAL OF THE FINISH SCRIPT PASSED ON TESTNET ════════\n'
fi
