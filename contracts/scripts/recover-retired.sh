#!/usr/bin/env bash
# What is left in the RETIRED v7.0 mainnet deployment, and how to get it back.
#
#   bash scripts/recover-retired.sh            # inventory on Base, Optimism, Arbitrum — READ-ONLY
#   bash scripts/recover-retired.sh apply      # the hot key takes back what it can (needs the phrase below)
#
# v7.0 (deployments/mainnet-v7_0.retired.json) was closed on chain: every
# gateway paused, every vault's cap at 0. Exits stayed open. Left there:
#
#   1. the canary bags — replica tokens the deployer bought during the
#      canaries. On Base (the hub) a sell is one local transaction: `apply`
#      sells them. On Optimism / Arbitrum a sell is a cross-chain round trip
#      through the retired hub (whose tank pays the reply): skipped unless
#      SPAWN_XCHAIN=1 — a bag of a few dollars is not worth the round trip.
#   2. the deployer's oUSD — canary payouts and holder fees, redeemable 1:1
#      for USDC from each vault: `apply` unwraps it where the vault has the
#      liquidity.
#   3. the gas tanks — ETH in the three adapters. Their admin is each chain's
#      retired TIMELOCK (the deployment was handed over), so the hot key
#      cannot drain them: OWNER schedules `recover(deployer)` on each
#      timelock, waits 48h, executes. scripts/recover-tanks.js prints both
#      calldatas, ready to paste; nothing is lost by waiting.
#
# Not runnable against mainnet by default: `apply` needs
#   SPAWN_RECOVER_CONFIRM=I_WANT_THE_V70_LEFTOVERS_BACK
# in the environment, and it only ever reads the *.retired.json state — the
# live v7.1 universes are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-list}"
export SPAWN_PROFILE=mainnet
export SPAWN_STATE_FILE="${SPAWN_STATE_FILE:-deployments/mainnet-v7_0.retired.json}"
export SPAWN_MANIFEST_FILE="${SPAWN_MANIFEST_FILE:-/dev/null}"
NETS="${SPAWN_RETIRED_NETS:-base optimism arbitrum}"

if [[ ! -f "$SPAWN_STATE_FILE" ]]; then
  echo "no retired state at $SPAWN_STATE_FILE"
  exit 1
fi
if [[ "$MODE" == "apply" ]]; then
  if [[ "${SPAWN_RECOVER_CONFIRM:-}" != "I_WANT_THE_V70_LEFTOVERS_BACK" ]]; then
    echo "apply needs SPAWN_RECOVER_CONFIRM=I_WANT_THE_V70_LEFTOVERS_BACK — nothing sent"
    exit 1
  fi
  export SPAWN_APPLY=1
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
elif [[ "$MODE" != "list" ]]; then
  echo "usage: bash scripts/recover-retired.sh [list|apply]"
  exit 1
fi

for n in $NETS; do
  printf '\n════════ %s ════════\n' "$n"
  npx hardhat run scripts/recover-retired.js --network "$n"
  printf -- '--- gas tank (%s)\n' "$n"
  SPAWN_RETIRED=1 SPAWN_DRY=1 npx hardhat run scripts/recover-tanks.js --network "$n"
done

if [[ "$MODE" == "list" ]]; then
  printf '\n════════ READ-ONLY INVENTORY DONE — nothing was sent ════════\n'
  echo "bags and oUSD: SPAWN_RECOVER_CONFIRM=I_WANT_THE_V70_LEFTOVERS_BACK bash scripts/recover-retired.sh apply"
  echo "gas tanks:     the OWNER wallet pastes the two calldatas printed above on each retired timelock (schedule, wait 48h, execute)"
else
  printf '\n════════ DONE — the gas tanks still wait for OWNER (calldata above) ════════\n'
fi
