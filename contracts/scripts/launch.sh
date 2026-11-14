#!/usr/bin/env bash
# The guarded launch of THE universe — docs/RUNBOOK.md in one resumable run.
#
#   bash scripts/launch.sh                # mainnet: Base (hub) + Optimism + Arbitrum + Ethereum + BNB Chain
#   bash scripts/launch.sh testnet        # the same sequence on the public testnets (rehearsal);
#                                         # Ethereum Sepolia / BNB testnet are skipped where the deployer has no gas
#
# (`bash scripts/launch-mainnet.sh` is the same script.)
#
# It stops at the first step that does not end the way the runbook says it
# must. Every step is idempotent: after a failure, fix the cause and run the
# same command again — finished steps send nothing, a canary that passed is
# not repeated.
#
# What it does, in order:
#   0. read-only preflight of every external address on the five live chains
#      (endpoint eids, Circle USDC + CCTP domains, BSC USDT, deployer budgets)
#   1. deploy — every vault opens with a CANARY cap (default 100 of its own
#      dollar: USDC, or USDT on BNB Chain):
#        the hub, each spoke, the hub again (wires them, sets the launch
#        ceiling of Ethereum BEFORE its gateway, the request ceilings, the
#        move routes), each spoke again (move routes to every other chain)
#   2. our own LayerZero verifier set on every pathway, both ends
#      cross-checked
#   3. prices from live quotes: reply units, spawn / open / move legs, the
#      hub-bound gas, the launch and request ceilings — spokes, hub, twice
#   4. canaries with the deployer's own money: the hub chain (local,
#      slippage-protected, launches the ONE canary token), then a round trip
#      from every spoke reusing it (BNB: USDT in, USDT out, and a claim moved
#      to Base in USDC; Ethereum: opened first if the launch skipped it, and
#      only if the live price is affordable — otherwise it says so and the
#      others go on)
#   5. status: the two-dollar backing check, the USDT exposure, the request
#      ceilings against what requests prepay
#
# What it does NOT do: the hand-over to the owner's timelock, raising the
# caps, publishing the site. Those are scripts/finish.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-${SPAWN_LAUNCH_PROFILE:-mainnet}}"
case "$PROFILE" in
  core) PROFILE=mainnet ;;
  bnb|ethereum)
    echo "✗ \"$PROFILE\" is no longer a universe of its own: it is a chain of THE universe."
    echo "  Run:  bash scripts/launch.sh"
    exit 1 ;;
esac
export SPAWN_PROFILE="$PROFILE"

# HOLD: while deployments/HOLD-MAINNET exists, no mainnet universe is launched
# from here — the file says why. A fork rehearsal passes SPAWN_IGNORE_HOLD=1
# (it sends nothing to a live chain). Delete the file to lift the hold.
if [[ "$PROFILE" != "testnet" && -f deployments/HOLD-MAINNET && "${SPAWN_IGNORE_HOLD:-}" != "1" ]]; then
  echo "✗ mainnet launch on hold:"
  sed 's/^/    /' deployments/HOLD-MAINNET
  exit 1
fi

LOG_DIR="${SPAWN_LOG_DIR:-deployments/logs}"
MARK_DIR="${SPAWN_MARK_DIR:-deployments}"
mkdir -p "$LOG_DIR" "$MARK_DIR"

# testnet: an OPTIONAL spoke where the deployer holds no gas is left out of
# this run (SPAWN_SKIP) — every script below then ignores it
if [[ "$PROFILE" == "testnet" && -z "${SPAWN_SKIP:-}" ]]; then
  SKIP=$(node -e "
const fs=require('fs');const {ethers}=require('ethers');const {PROFILES}=require('./config/profiles');
const p=PROFILES.testnet;let pk;try{pk=(fs.readFileSync('.env','utf8').match(/^DEPLOYER_PK=(0x[0-9a-fA-F]{64})/m)||[])[1]}catch{}
const who=process.env.SPAWN_FORK_AS||(pk&&new ethers.Wallet(pk).address);
(async()=>{const out=[];for(const [n,c] of Object.entries(p.nets)){if(!c.optional)continue;
 try{const b=who?await new ethers.JsonRpcProvider(c.rpc,c.chainId,{staticNetwork:true}).getBalance(who):0n;if(b<ethers.parseEther('0.002'))out.push(n)}catch{out.push(n)}}
 process.stdout.write(out.join(','))})()") || SKIP=""
  if [[ -n "$SKIP" ]]; then
    echo "testnet: no gas for the deployer on ${SKIP//,/, } — left out of this run"
    export SPAWN_SKIP="$SKIP"
  fi
fi

# the topology comes from the profile, not from this script
TOPO=$(node -e "
const {PROFILES,activeNets}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];
if(!p){console.error('unknown universe \"'+process.env.SPAWN_PROFILE+'\" ('+Object.keys(PROFILES).join(' | ')+')');process.exit(1)}
const nets=activeNets(p);
const spokes=Object.keys(nets).filter(n=>nets[n].role==='spoke');
console.log([p.hub,spokes.join(',')||'-',p.mainnet?1:0,p.dvn?1:0,p.canaryCap||100].join(' '));
") || exit 1
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; [[ "$SPOKES" == "-" ]] && SPOKES=""
IS_MAINNET="$3"; WITH_DVN="$4"; CANARY_CAP="$5"

if [[ "$IS_MAINNET" == "1" ]]; then
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
fi
# whole dollars of EACH CHAIN's own dollar; the tooling scales by its decimals
export SPAWN_DEPOSIT_CAP_USDC="${SPAWN_CANARY_CAP_USDC:-$CANARY_CAP}"
SMOKE_ENV="SPAWN_REHEARSAL=1"
[[ -n "${SPAWN_CANARY_BUY:-}" ]] && SMOKE_ENV="SMOKE_BUY_USDC=$SPAWN_CANARY_BUY"

# hh <net> <script.js> — one hardhat CLI on one network. In a fork rehearsal
# (scripts/fork-rehearsal.js) every network is a local anvil fork.
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
# (default 4: these steps are idempotent and resume).
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

# canary <net> <label> — once per deployment+net (each one spends real
# money): a canary that passed is not repeated. Exit code 4 = the chain's
# canary budget cannot afford a round trip right now (Ethereum): said
# plainly, recorded, and the launch goes on with the other chains.
source scripts/lib-canary.sh # a mark is bound to the gateway it proved
SKIPPED_CANARIES=""
canary() {
  local net="$1" what="$2" log code=0
  if canary_passed "$net"; then
    echo "canary $net — already passed ($(cat "$(canary_mark_file "$net")"))"
    return 0
  fi
  log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-canary_$net.log"
  echo "→ canary $net ($what)"
  ( export $SMOKE_ENV; hh "$net" smoke.js ) > "$log" 2>&1 || code=$?
  tail -n 12 "$log" | cut -c1-240
  if [[ "$code" == "4" ]] && grep -q 'CANARY NOT AFFORDABLE' "$log"; then
    echo "⚠ canary $net NOT RUN — not affordable right now (see above). The other chains go on;"
    echo "  $net keeps the canary cap until its canary passes (finish.sh tries it again)."
    SKIPPED_CANARIES="$SKIPPED_CANARIES $net"
    return 0
  fi
  if [[ "$code" != "0" ]] || ! grep -q '🎉' "$log"; then
    echo "✗ canary $net failed — stopping. Full output: contracts/$log"
    echo "  (this script resumes: fix the cause and run the same command again)"
    echo "  ➜ Écris « fait » à Claude : il lira ce journal."
    exit 1
  fi
  canary_record "$net"
  echo "✓ canary $net"
}

PLAN='match(es)? the plan'
echo "launch — profile $PROFILE — hub $HUB — spokes ${SPOKES:-none} — canary cap $SPAWN_DEPOSIT_CAP_USDC (each chain's own dollar)"

if [[ "$IS_MAINNET" == "1" ]]; then
  step "0. preflight (read-only)"
  logged "preflight" 'every external address re-derived' npx hardhat run scripts/preflight.js
fi

step "1. deploy"
logged "deploy $HUB (hub)" "$PLAN" hh "$HUB" deploy.js
for n in $SPOKES; do logged "deploy $n" "$PLAN" hh "$n" deploy.js; done
logged "wire $HUB" "$PLAN" hh "$HUB" deploy.js
for n in $SPOKES; do logged "refresh $n" "$PLAN" hh "$n" deploy.js; done

if [[ "$WITH_DVN" == "1" ]]; then
  step "2. verifier set (DVNs) — one set on every pathway"
  for n in $HUB $SPOKES; do
    logged "configure-dvn $n" 'verifier set configured and read back' hh "$n" configure-dvn.js
  done
  logged "verify both ends of every pathway" 'both ends name the configured verifier set' SPAWN_VERIFY=1 hh "$HUB" configure-dvn.js
else
  step "2. verifier set — skipped (testnets ride LayerZero's default set)"
fi

step "3. prices from live quotes (spokes, then the hub — twice, so the ceilings settle)"
for round in 1 2; do
  for n in $SPOKES; do logged "tune-fees $n (round $round)" 'tune-fees' SPAWN_APPLY=1 hh "$n" tune-fees.js; done
  logged "tune-fees $HUB (round $round)" 'tune-fees' SPAWN_APPLY=1 hh "$HUB" tune-fees.js
done
logged "read back $HUB" "$PLAN" hh "$HUB" deploy.js

step "4. canaries — the deployer's own money"
canary "$HUB" "local, slippage-protected — launches the canary token"
if [[ -z "${SPAWN_SKIP_XCHAIN_CANARY:-}" ]]; then
  for n in $SPOKES; do canary "$n" "cross-chain round trip"; done
fi

step "5. status"
hh "$HUB" status.js

if [[ -n "$SKIPPED_CANARIES" ]]; then
  echo
  echo "⚠ canary NOT run (not affordable right now):$SKIPPED_CANARIES — those vaults stay at the canary cap."
fi
if [[ "$IS_MAINNET" == "1" ]]; then
  cat <<EOF

════════ DEPLOYED AND PROVEN — NOT OPEN YET ════════
Every vault is capped at the canary level and the site does not point here.
➜ Écris « fait » à Claude. Il vérifie tout, puis te donne la ligne suivante :
     bash scripts/finish.sh      (passation au verrou de 48 h, plafonds de lancement)
EOF
else
  printf '\n════════ REHEARSAL OF THE LAUNCH SCRIPT PASSED ON TESTNET ════════\n'
fi
