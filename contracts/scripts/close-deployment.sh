#!/usr/bin/env bash
# Closes ONE live universe to NEW exposure, for good or for a while: every
# gateway paused (no new buy, no new launch) and every vault's deposit cap at
# 0. Nothing is ever locked in: sells, claims, fee pulls and unwraps stay
# open, and messages already in flight are still handled.
#
#   bash scripts/close-deployment.sh              # the CORE universe (Base + Optimism + Arbitrum)
#   bash scripts/close-deployment.sh bnb          # the BNB universe
#   bash scripts/close-deployment.sh ethereum     # the Ethereum universe
#
# Runs with the deployer hot key (guardian + operator). Idempotent: run it
# again after a network blip. SPAWN_CLOSE_NETS="base optimism" limits it.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-${SPAWN_LAUNCH_PROFILE:-mainnet}}"
[[ "$PROFILE" == "core" ]] && PROFILE=mainnet
export SPAWN_PROFILE="$PROFILE"
export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY

DEFAULT_NETS=$(node -e "
const {PROFILES,activeNets}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];
if(!p||!p.mainnet){console.error('unknown mainnet universe \"'+process.env.SPAWN_PROFILE+'\" (mainnet | bnb | ethereum, or core)');process.exit(1)}
const nets=activeNets(p);
console.log([p.hub,...Object.keys(nets).filter(n=>n!==p.hub&&!nets[n].rehearsalOnly)].join(' '))") || exit 1
NETS="${SPAWN_CLOSE_NETS:-$DEFAULT_NETS}"

# attempt <label> <success-regex> <command…> — these steps are idempotent,
# so a lagging node or a network blip is simply retried
attempt() {
  local label="$1" ok="$2"; shift 2
  local try out
  for try in 1 2 3 4; do
    if out=$("$@" 2>&1) && echo "$out" | grep -Eq "$ok"; then
      echo "$out" | tail -n 3
      echo "✓ $label"
      return 0
    fi
    echo "$out" | tail -n 4 | cut -c1-200
    echo "… $label not clean (attempt $try of 4); retrying in 15s"
    sleep 15
  done
  echo "✗ $label FAILED — run this script again"
  exit 1
}

echo "closing — universe $PROFILE — $NETS"
for n in $NETS; do
  printf '\n════════ %s ════════\n' "$n"
  attempt "pause the $n gateway" 'already paused|gateway\.pause\(\) ✓' env SPAWN_GATE=pause npx hardhat run scripts/gate.js --network "$n"
  attempt "close the $n vault to deposits" 'already set|setDepositCap\(' \
    env SPAWN_APPLY=1 SPAWN_CAP_USDC=0 npx hardhat run scripts/set-cap.js --network "$n"
done

printf '\n════════ status ════════\n'
npx hardhat run scripts/status.js
printf '\n════════ %s: CLOSED TO NEW EXPOSURE — exits stay open ════════\n' "$PROFILE"
