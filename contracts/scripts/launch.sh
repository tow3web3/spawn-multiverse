#!/usr/bin/env bash
# The guarded launch of ONE universe — docs/RUNBOOK.md in one resumable run.
#
#   bash scripts/launch.sh                # the CORE universe: Base + Optimism + Arbitrum, USDC
#   bash scripts/launch.sh bnb            # the BNB universe: BNB Chain alone, USDT
#   bash scripts/launch.sh ethereum       # the Ethereum universe: Ethereum alone, USDC
#   bash scripts/launch.sh testnet        # the same sequence on the public testnets (rehearsal)
#
# (`bash scripts/launch-mainnet.sh` is the same script for the core universe;
#  SPAWN_LAUNCH_PROFILE=<universe> works too.)
#
# It stops at the first step that does not end the way the runbook says it
# must. Every step is idempotent: after a failure, fix the cause and run the
# same command again — finished steps send nothing, a canary that passed is
# not repeated.
#
# What it does, in order:
#   0. read-only preflight of every external address on the live chains
#      (single-chain universes: also what a launch and a buy cost in gas)
#   1. deploy — vaults open with a CANARY cap (default 100 dollars each)
#        core:         hub, spokes, hub again (wires them), spokes again
#        single-chain: the hub and its local gateway, once
#   2. core only: our own LayerZero verifier set on every pathway, both ends
#      cross-checked
#   3. core only: reply budgets re-priced from live quotes
#   4. canary trades with the deployer's own money. Local on the hub chain —
#      through the slippage-protected entrypoints, after PROVING that a
#      minimum no trade can meet is refused ("GW: min out"). Core: then a
#      full round trip from the first spoke.
#   5. status: the backing check
#
# What it does NOT do: the hand-over to the owner's timelock, raising the
# caps, publishing the site. Those are scripts/finish.sh <universe>.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-${SPAWN_LAUNCH_PROFILE:-mainnet}}"
[[ "$PROFILE" == "core" ]] && PROFILE=mainnet
export SPAWN_PROFILE="$PROFILE"

# HOLD: while deployments/HOLD-MAINNET exists, no mainnet universe is launched
# from here — the file says why. A fork rehearsal passes SPAWN_IGNORE_HOLD=1
# (it sends nothing to a live chain). Delete the file to lift the hold.
if [[ "$PROFILE" != "testnet" && -f deployments/HOLD-MAINNET && "${SPAWN_IGNORE_HOLD:-}" != "1" ]]; then
  echo "✗ mainnet launch on hold:"
  sed 's/^/    /' deployments/HOLD-MAINNET
  exit 1
fi

# the topology comes from the profile, not from this script
TOPO=$(node -e "
const {PROFILES,activeNets}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];
if(!p){console.error('unknown universe \"'+process.env.SPAWN_PROFILE+'\" ('+Object.keys(PROFILES).join(' | ')+', or core)');process.exit(1)}
const nets=activeNets(p);
const spokes=Object.keys(nets).filter(n=>nets[n].role==='spoke'&&!nets[n].rehearsalOnly);
const live=p.launchSpokes||spokes;
console.log([p.hub,live.join(',')||'-',p.mainnet?1:0,p.dvn?1:0,p.native||'ETH',(p.dollar&&p.dollar.symbol)||'USDC',p.universe||p.name].join(' '));
") || exit 1
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; [[ "$SPOKES" == "-" ]] && SPOKES=""
IS_MAINNET="$3"; WITH_DVN="$4"; COIN="$5"; DOLLAR="$6"; UNIVERSE="$7"
FIRST_SPOKE="${SPOKES%% *}"

if [[ "$IS_MAINNET" == "1" ]]; then
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
  # whole dollars of the universe; the tooling scales by the token's decimals
  export SPAWN_DEPOSIT_CAP_USDC="${SPAWN_CANARY_CAP_USDC:-100}"
  SMOKE_ENV="SMOKE_BUY_USDC=${SPAWN_CANARY_BUY:-3}"
else
  SMOKE_ENV="SPAWN_REHEARSAL=1"
fi
LOG_DIR="${SPAWN_LOG_DIR:-deployments/logs}"
MARK_DIR="${SPAWN_MARK_DIR:-deployments}"
mkdir -p "$LOG_DIR" "$MARK_DIR"

# hh <net> <script.js> — one hardhat CLI on one network. In a fork rehearsal
# (scripts/fork-universe.js, fork-rehearsal) every network is a local anvil fork.
hh() {
  local net="$1" script="$2"
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then
    FORK="$net" SPAWN_NET="$net" npx hardhat run "scripts/$script" --network fork
  else
    npx hardhat run "scripts/$script" --network "$net"
  fi
}

step() { printf '\n════════ %s ════════\n' "$*"; }

# logged <label> <success-regex> [VAR=value…] <command…> — output kept in a
# log file; success = exit 0 AND the line that proves it. LOG_TRIES attempts
# (default 4: these steps are idempotent and resume; a canary passes 1).
logged() {
  local label="$1" ok="$2"; shift 2
  local try tries="${LOG_TRIES:-4}" log
  for try in $(seq 1 "$tries"); do
    log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-$(echo "$label" | tr -c 'A-Za-z0-9\n' '_').log"
    echo "→ $label (attempt $try of $tries)"
    if (
      while [[ "${1:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do export "$1"; shift; done
      "$@"
    ) > "$log" 2>&1 && grep -Eq "$ok" "$log"; then
      tail -n 10 "$log" | cut -c1-240
      echo "✓ $label"
      return 0
    fi
    tail -n 16 "$log" | cut -c1-240
    if [[ "$try" != "$tries" ]]; then echo "… not clean; resuming in 20s"; sleep "${SPAWN_RETRY_SLEEP:-20}"; fi
  done
  echo "✗ $label did not finish cleanly — stopping. Full output: contracts/$log"
  echo "  (this script resumes: fix the cause and run the same command again)"
  echo "  ➜ Écris « fait » à Claude : il lira ce journal."
  exit 1
}

# canary <net> <label> — once per universe+net: a canary that passed is not
# repeated on a re-run (each one launches a real token)
source scripts/lib-canary.sh # a mark is bound to the gateway it proved
canary() {
  local net="$1" what="$2"
  if canary_passed "$net"; then
    echo "canary $net — already passed ($(cat "$(canary_mark_file "$net")"))"
    return 0
  fi
  LOG_TRIES=1 logged "canary $net ($what)" '🎉' "$SMOKE_ENV" hh "$net" smoke.js
  canary_record "$net"
}

PLAN='match(es)? the plan'
echo "launch — universe $UNIVERSE (profile $PROFILE) — hub $HUB${SPOKES:+ — spokes $SPOKES} — gas in $COIN, settled in $DOLLAR"

if [[ "$IS_MAINNET" == "1" ]]; then
  step "0. preflight (read-only)"
  logged "preflight" 'every external address re-derived' npx hardhat run scripts/preflight.js
fi

step "1. deploy"
logged "deploy $HUB (hub)" "$PLAN" hh "$HUB" deploy.js
if [[ -n "$SPOKES" ]]; then
  for n in $SPOKES; do logged "deploy $n" "$PLAN" hh "$n" deploy.js; done
  logged "wire $HUB" "$PLAN" hh "$HUB" deploy.js
  for n in $SPOKES; do logged "refresh $n" "$PLAN" hh "$n" deploy.js; done
fi

if [[ -n "$SPOKES" && "$WITH_DVN" == "1" ]]; then
  step "2. verifier set (DVNs)"
  for n in $HUB $SPOKES; do
    logged "configure-dvn $n" 'verifier set configured and read back' hh "$n" configure-dvn.js
  done
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then
    logged "verify both ends of every pathway" 'both ends name the configured verifier set' SPAWN_VERIFY=1 hh "$HUB" configure-dvn.js
  else
    logged "verify both ends of every pathway" 'both ends name the configured verifier set' \
      SPAWN_VERIFY=1 npx hardhat run scripts/configure-dvn.js --network "$HUB"
  fi
elif [[ -n "$SPOKES" ]]; then
  step "2. verifier set — skipped (testnets ride LayerZero's default set)"
else
  step "2. verifier set — none: nothing leaves this chain (no route is ever set)"
fi

if [[ -n "$SPOKES" ]]; then
  step "3. reply budgets from live quotes"
  for n in $HUB $SPOKES; do
    logged "tune-fees $n" 'tune-fees' SPAWN_APPLY=1 hh "$n" tune-fees.js
  done
else
  step "3. reply budgets — none: every quote is 0 in a single-chain universe"
fi

step "4. canary — the deployer's own money"
canary "$HUB" "local, slippage-protected"
if [[ -n "$FIRST_SPOKE" && -z "${SPAWN_SKIP_XCHAIN_CANARY:-}" ]]; then
  canary "$FIRST_SPOKE" "cross-chain"
fi

step "5. status"
if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then hh "$HUB" status.js; else npx hardhat run scripts/status.js; fi

if [[ "$IS_MAINNET" == "1" ]]; then
  cat <<EOF

════════ $UNIVERSE: DEPLOYED AND PROVEN — NOT OPEN YET ════════
Vaults are capped at the canary level and the site does not point here.
➜ Écris « fait » à Claude. Il vérifie tout, puis te donne la ligne suivante :
     bash scripts/finish.sh $PROFILE      (passation au verrou de 48 h, plafonds de lancement)
EOF
else
  printf '\n════════ REHEARSAL OF THE LAUNCH SCRIPT PASSED ON TESTNET ════════\n'
fi
