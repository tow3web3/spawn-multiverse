#!/usr/bin/env bash
# The guarded mainnet launch — docs/RUNBOOK.md §3–§5 in one resumable run.
#
#   bash scripts/launch-mainnet.sh            # from contracts/
#
# It stops at the first step that does not end the way the runbook says it
# must. Every step is idempotent: after a failure, fix the cause and run the
# same command again — finished steps send nothing.
#
# What it does, in order:
#   0. read-only preflight of every external address on the live chains
#   1. deploy: hub (Base), spokes (Optimism, Arbitrum), hub again, spokes again
#      — vaults open with a CANARY cap (default 100 USDC each)
#   2. our own LayerZero verifier set on every pathway, then a cross-chain check
#   3. reply budgets re-priced from live quotes
#   4. canary trades with the deployer's own USDC: local on Base, then a full
#      round trip from Optimism
#   5. status: the global backing check
#
# What it does NOT do: the hand-over to the owner's timelock, raising the
# caps, publishing the site. Those are scripts/finish-mainnet.sh, once the
# owner's address is proven.
#
# SPAWN_LAUNCH_PROFILE=testnet runs the same sequence on the public testnets
# (no verifier-set step: testnets ride LayerZero's defaults) — the rehearsal
# of this very script.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${SPAWN_LAUNCH_PROFILE:-mainnet}"
export SPAWN_PROFILE="$PROFILE"
if [[ "$PROFILE" == "mainnet" ]]; then
  NETS="base optimism arbitrum"
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
  export SPAWN_DEPOSIT_CAP_USDC="${SPAWN_CANARY_CAP_USDC:-100}"
  SMOKE_ENV="SMOKE_BUY_USDC=3"
elif [[ "$PROFILE" == "testnet" ]]; then
  NETS="baseSepolia optimismSepolia arbitrumSepolia"
  SMOKE_ENV="SPAWN_REHEARSAL=1"
else
  echo "unknown SPAWN_LAUNCH_PROFILE \"$PROFILE\" (mainnet | testnet)"; exit 1
fi
set -- $NETS
HUB="$1"; SPOKE_A="$2"; SPOKE_B="$3"
LOG_DIR="deployments/logs"
mkdir -p "$LOG_DIR"

step() { printf '\n════════ %s ════════\n' "$*"; }

# run <label> <success-regex> <command…> — retries a flaky public RPC (the
# scripts are resumable) and insists on the line that proves success.
run() {
  local label="$1" ok="$2"; shift 2
  local log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-$(echo "$label" | tr -c 'A-Za-z0-9\n' '_').log"
  local try tries="${RUN_TRIES:-4}"
  for try in $(seq 1 "$tries"); do
    echo "→ $label (attempt $try)"
    if "$@" > "$log" 2>&1 && grep -Eq "$ok" "$log"; then
      tail -n 12 "$log"
      echo "✓ $label"
      return 0
    fi
    tail -n 12 "$log"
    echo "… $label did not finish cleanly; waiting 20s before resuming"
    sleep 20
  done
  echo "✗ $label FAILED — full output: contracts/$log"
  exit 1
}

PLAN='match(es)? the plan'
echo "launch — profile $PROFILE — hub $HUB, spokes $SPOKE_A + $SPOKE_B"

if [[ "$PROFILE" == "mainnet" ]]; then
  step "0. preflight (read-only)"
  run "preflight" 'every external address re-derived' npx hardhat run scripts/preflight.js
fi

step "1. deploy"
run "deploy $HUB (hub)" "$PLAN" npx hardhat run scripts/deploy.js --network "$HUB"
run "deploy $SPOKE_A" "$PLAN" npx hardhat run scripts/deploy.js --network "$SPOKE_A"
run "deploy $SPOKE_B" "$PLAN" npx hardhat run scripts/deploy.js --network "$SPOKE_B"
run "wire $HUB" "$PLAN" npx hardhat run scripts/deploy.js --network "$HUB"
run "refresh $SPOKE_A" "$PLAN" npx hardhat run scripts/deploy.js --network "$SPOKE_A"
run "refresh $SPOKE_B" "$PLAN" npx hardhat run scripts/deploy.js --network "$SPOKE_B"

if [[ "$PROFILE" == "mainnet" ]]; then
  step "2. verifier set (DVNs)"
  for n in $NETS; do
    run "configure-dvn $n" 'verifier set configured and read back' npx hardhat run scripts/configure-dvn.js --network "$n"
  done
  run "verify both ends of every pathway" 'both ends name the configured verifier set' \
    env SPAWN_VERIFY=1 npx hardhat run scripts/configure-dvn.js --network "$HUB"
else
  step "2. verifier set — skipped (testnets ride LayerZero's default set)"
fi

step "3. reply budgets from live quotes"
for n in $NETS; do
  run "tune-fees $n" 'tune-fees' env SPAWN_APPLY=1 npx hardhat run scripts/tune-fees.js --network "$n"
done

step "4. canary — the deployer's own money"
# one attempt each: a canary that fails half-way is a finding, not a flake
RUN_TRIES=1 run "canary $HUB (local)" '🎉' env "$SMOKE_ENV" npx hardhat run scripts/smoke.js --network "$HUB"
RUN_TRIES=1 run "canary $SPOKE_A (cross-chain)" '🎉' env "$SMOKE_ENV" npx hardhat run scripts/smoke.js --network "$SPOKE_A"

step "5. status"
npx hardhat run scripts/status.js

if [[ "$PROFILE" == "mainnet" ]]; then
  cat <<'EOF'

════════ DEPLOYED AND PROVEN ON MAINNET — NOT OPEN YET ════════
Vaults are capped at the canary level and the site does not point here.
Next: bash scripts/finish-mainnet.sh 0x<OWNER address> — hand-over, launch caps.
EOF
else
  printf '\n════════ REHEARSAL OF THE LAUNCH SCRIPT PASSED ON TESTNET ════════\n'
fi
