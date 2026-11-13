#!/usr/bin/env bash
# Adds a spoke chain to a LIVE, handed-over deployment — through the timelocks.
#
#   bash scripts/add-chain.sh ethereum prepare     # from contracts/ — day 0
#   bash scripts/add-chain.sh ethereum finish      # after the delay (48h on mainnet)
#
# Why two commands: once a deployment is handed over, every topology step
# (the hub's route to the new chain, pad.setGateway, the CCTP peers, the hub
# side of the DVN set) belongs to each chain's TimelockController. OWNER
# schedules them, they wait IN PUBLIC for the timelock delay, OWNER executes.
#
# prepare:
#   0. read-only preflight of every chain, the new one included        (mainnet)
#   1. deploy the new spoke — vault CLOSED, gateway PAUSED: until the hub
#      has wired it, anything a user sent from it would be a message the hub
#      rejects
#   2. its side of the LayerZero verifier set                           (mainnet)
#   3. the operator pre-steps on the hub and on every existing spoke (the
#      new destination's gas limit, one more spawn leg) — spawns keep working
#   4. ONE timelock batch per chain, scheduled by OWNER (topped up with gas
#      by the deployer if it has none); the ETA is printed
#
# finish (refuses, with the time left, while a batch is inside its delay):
#   1. OWNER executes the batches
#   2. reply budgets, spawn legs and hub-bound gas re-priced on every chain
#      from live quotes — at once, the hub first
#   3. the verifier sets of every pathway cross-checked, both ends   (mainnet)
#   4. the new spoke opens with a CANARY cap, a full round trip from it with
#      the deployer's own money, its hand-over to OWNER's timelock, the
#      launch cap, status
#
# Every step is idempotent: after a failure fix the cause and run the same
# command again. Nothing here can be undone once `finish` has executed the
# hub batch: pad.setGateway is PERMANENT, and from then on every launch pays
# to SYNC the new chain. Until then the guardian can veto:
#   SPAWN_OPS=cancel SPAWN_OP_ID=0x… npx hardhat run scripts/timelock-ops.js --network <hub>
#
# SPAWN_LAUNCH_PROFILE=testnet runs the same sequence on the testnets (their
# timelocks have no delay: prepare, then finish at once).
set -euo pipefail
cd "$(dirname "$0")/.."

NEW="${1:-}"
PHASE="${2:-}"
if [[ -z "$NEW" || ( "$PHASE" != "prepare" && "$PHASE" != "finish" ) ]]; then
  echo "usage: bash scripts/add-chain.sh <network> prepare|finish"
  exit 1
fi

PROFILE="${SPAWN_LAUNCH_PROFILE:-mainnet}"
export SPAWN_PROFILE="$PROFILE"
export SPAWN_ENABLE="${SPAWN_ENABLE:-$NEW}"
if [[ "$PROFILE" == "mainnet" ]]; then
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
  SMOKE_ENV="SMOKE_BUY_USDC=3"
  CANARY_CAP="${SPAWN_CANARY_CAP_USDC:-100}"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-25000}"
  WITH_DVN=1
elif [[ "$PROFILE" == "testnet" ]]; then
  SMOKE_ENV="SPAWN_REHEARSAL=1"
  CANARY_CAP="${SPAWN_CANARY_CAP_USDC:-1000000}"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-500000000}"
  WITH_DVN=0
else
  echo "unknown SPAWN_LAUNCH_PROFILE \"$PROFILE\" (mainnet | testnet)"; exit 1
fi
LOG_DIR="deployments/logs"
mkdir -p "$LOG_DIR"

# the topology, from the profile and the state file: the hub, the spokes
# already live (deployed AND handed over), who holds the roles
TOPO=$(NEW="$NEW" node -e "
const fs=require('fs');const {PROFILES}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];const n=process.env.NEW;
const fail=(m)=>{console.error(m);process.exit(1)};
if(!p.nets[n])fail('\"'+n+'\" is not a network of the '+p.name+' profile ('+Object.keys(p.nets).join(', ')+')');
if(p.nets[n].role!=='spoke')fail(n+' is the hub');
let st={};try{st=JSON.parse(fs.readFileSync(p.stateFile,'utf8'))}catch{}
const hub=st[p.hub];
if(!hub||!hub.handover)fail('the hub ('+p.hub+') is not deployed and handed over — use launch-mainnet.sh / finish-mainnet.sh for a first deployment');
const spokes=Object.keys(p.nets).filter(k=>k!==p.hub&&k!==n&&st[k]&&st[k].gateway&&st[k].handover);
console.log([p.hub,spokes.join(','),hub.handover.owner,hub.handover.operator,hub.handover.guardian].join(' '));
")
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; OWNER="$3"; OPERATOR="$4"; GUARDIAN="$5"

# hh <net> <script.js> — one hardhat CLI on one network. In a fork rehearsal
# (scripts/fork-addchain.js) every network is a local anvil fork.
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
# (default 4: every step here is idempotent and resumes; the canary passes 1).
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
      tail -n 8 "$log" | cut -c1-240
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

PLAN='match(es)? the plan'
# after the hand-over a run that leaves admin steps for the timelock is a success too
PREP="$PLAN|need another key"

echo "add-chain — profile $PROFILE — new spoke: $NEW — hub: $HUB — live spokes: ${SPOKES:-none} — phase: $PHASE"
echo "OWNER $OWNER · operator $OPERATOR · guardian $GUARDIAN"

if [[ "$PHASE" == "prepare" ]]; then
  if [[ "$PROFILE" == "mainnet" && -z "${SPAWN_FORK_REHEARSAL:-}" ]]; then
    step "0. preflight (read-only), the new chain included"
    logged "preflight" 'every external address re-derived' npx hardhat run scripts/preflight.js
  fi

  step "1. deploy $NEW — vault closed, gateway paused"
  logged "deploy $NEW" "$PLAN" SPAWN_OPEN_DEPOSITS=0 hh "$NEW" deploy.js
  logged "pause $NEW" 'already paused|gateway\.pause\(\) ✓' SPAWN_GATE=pause hh "$NEW" gate.js

  if [[ "$WITH_DVN" == "1" ]]; then
    step "2. the verifier set on $NEW's side"
    logged "configure-dvn $NEW" 'verifier set configured and read back' hh "$NEW" configure-dvn.js
  fi

  step "3. operator pre-steps on the live chains (spawns keep working)"
  logged "pre-steps $HUB" "$PREP" hh "$HUB" deploy.js
  for n in $SPOKES; do
    logged "pre-steps $n" "$PREP" hh "$n" deploy.js
  done

  step "4. one timelock batch per chain, scheduled by OWNER"
  for n in $HUB $SPOKES; do
    logged "schedule $n" '✓ scheduled|nothing to schedule' SPAWN_OPS=schedule SPAWN_TOPUP=1 hh "$n" timelock-ops.js
  done
  SPAWN_OPS=list hh "$HUB" timelock-ops.js

  cat <<EOF

════════ PREPARED — NOTHING IS WIRED YET ════════
$NEW is deployed, closed and paused; the admin steps wait on the timelocks.
When the delay has passed:   bash scripts/add-chain.sh $NEW finish
To veto before then:         SPAWN_OPS=cancel SPAWN_OP_ID=<id above> npx hardhat run scripts/timelock-ops.js --network $HUB
EOF
  exit 0
fi

# ───────────────────────────────── finish ─────────────────────────────────

step "1. OWNER executes the batches"
for n in $HUB $SPOKES; do
  log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-execute_$n.log"
  echo "→ execute $n"
  code=0
  ( export SPAWN_OPS=execute SPAWN_TOPUP=1; hh "$n" timelock-ops.js ) > "$log" 2>&1 || code=$?
  tail -n 10 "$log" | cut -c1-240
  if [[ "$code" == "3" ]]; then
    echo "⏳ $n: a batch is still inside its delay — nothing was changed. Run this command again after the time shown above."
    exit 3
  elif [[ "$code" != "0" ]]; then
    echo "✗ execute $n failed — full output: contracts/$log (this script resumes)"
    exit 1
  fi
  echo "✓ execute $n"
  if [[ "$n" == "$HUB" ]]; then
    # from this moment every spawn SYNCs the new chain: price it NOW
    logged "tune-fees $HUB" 'tune-fees' SPAWN_APPLY=1 hh "$HUB" tune-fees.js
  fi
done

step "2. every chain re-priced from live quotes; wiring read back"
for n in $SPOKES $NEW; do
  logged "tune-fees $n" 'tune-fees' SPAWN_APPLY=1 hh "$n" tune-fees.js
done
# SPAWN_OPEN_DEPOSITS=0: a read-back must not open the new vault at the
# launch cap — it opens below, at the canary cap, and only after this
for n in $HUB $SPOKES $NEW; do
  logged "read back $n" "$PLAN" SPAWN_OPEN_DEPOSITS=0 hh "$n" deploy.js
done

if [[ "$WITH_DVN" == "1" ]]; then
  step "3. verifier sets, both ends of every pathway"
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then
    logged "verify pathways" 'both ends name the configured verifier set' SPAWN_VERIFY=1 hh "$HUB" configure-dvn.js
  else
    logged "verify pathways" 'both ends name the configured verifier set' SPAWN_VERIFY=1 npx hardhat run scripts/configure-dvn.js --network "$HUB"
  fi
fi

step "4. $NEW opens with a canary cap ($CANARY_CAP USDC)"
logged "canary cap $NEW" 'already set|setDepositCap\(' SPAWN_APPLY=1 SPAWN_CAP_USDC="$CANARY_CAP" hh "$NEW" set-cap.js
logged "unpause $NEW" 'already open|gateway\.unpause\(\) ✓' SPAWN_GATE=unpause hh "$NEW" gate.js

CANARY_MARK="deployments/.canary-$PROFILE-$NEW.ok"
if [[ -n "${SPAWN_SKIP_CANARY:-}" ]]; then
  step "canary from $NEW — SKIPPED (SPAWN_SKIP_CANARY)"
elif [[ -f "$CANARY_MARK" ]]; then
  step "canary from $NEW — already passed ($(cat "$CANARY_MARK"))"
else
  step "canary — a full round trip from $NEW (the deployer's own money)"
  LOG_TRIES=1 logged "canary $NEW (cross-chain)" '🎉' "$SMOKE_ENV" hh "$NEW" smoke.js
  date -u +%Y-%m-%dT%H:%M:%SZ > "$CANARY_MARK"
fi

step "5. hand-over of $NEW — OWNER $OWNER"
logged "hand-over $NEW" 'hand-over complete' SPAWN_OWNER="$OWNER" SPAWN_OPERATOR="$OPERATOR" SPAWN_GUARDIAN="$GUARDIAN" hh "$NEW" handover.js
logged "launch cap $NEW" 'already set|setDepositCap\(' SPAWN_APPLY=1 SPAWN_CAP_USDC="$LAUNCH_CAP" hh "$NEW" set-cap.js

step "6. status"
if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then
  hh "$HUB" status.js
else
  npx hardhat run scripts/status.js
fi

cat <<EOF

════════ $NEW IS LIVE ════════
Wired on the hub, priced, handed over to OWNER's timelock, capped at $LAUNCH_CAP USDC.
Next: publish the site — the frontend manifest now lists $NEW.
EOF
