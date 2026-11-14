#!/usr/bin/env bash
# After launch.sh: hand THE universe to its owner and open it.
#
#   bash scripts/finish.sh                # mainnet (the five chains launch.sh deployed)
#   bash scripts/finish.sh testnet        # rehearsal on the public testnets
#
# (`bash scripts/finish-mainnet.sh` is the same script.)
#
# OWNER = the wallet in contracts/.env.owner (or SPAWN_FINISH_OWNER=0x… for a
# Safe / hardware wallet). It becomes the only proposer/executor of the 48h
# timelock that owns every contract, on every chain. If nobody can sign for
# it, admin powers are gone for good — so control of it must be PROVEN:
# either its key is the one in contracts/.env.owner, or it has already sent a
# transaction on the hub chain.
#
# Roles after this script:
#   admin    = the timelock (OWNER schedules, waits 48h in public, executes)
#   operator = the deployer hot key: reply budgets, legs, ceilings, deposit
#              caps, rebalancing between the USDC vaults, unpause, resync
#   guardian = the deployer hot key: pause, veto a scheduled admin change
# Neither hot role can withdraw funds or rewire the protocol.
#
# Steps: the canary of any chain whose canary has not passed yet (Ethereum,
# if launch.sh found it unaffordable) — tried once more; the hand-over on
# every chain; status; then the LAUNCH CAPS, per chain: 25,000 USDC for each
# USDC vault, 10,000 USDT for the BNB vault (what bounds everyone's exposure
# to a USDT de-peg). A chain whose canary has not passed keeps the canary
# cap, and the script says so. Resumable: finished steps send nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-${SPAWN_LAUNCH_PROFILE:-mainnet}}"
case "$PROFILE" in
  core) PROFILE=mainnet ;;
  bnb|ethereum)
    echo "✗ \"$PROFILE\" is no longer a universe of its own: it is a chain of THE universe."
    echo "  Run:  bash scripts/finish.sh"
    exit 1 ;;
esac
if [[ "$PROFILE" =~ ^0x ]]; then
  echo "usage: bash scripts/finish.sh [mainnet|testnet]   (another owner: SPAWN_FINISH_OWNER=0x…)"
  exit 1
fi
export SPAWN_PROFILE="$PROFILE"

# the chains launch.sh deployed (state file), the hub's RPC, per-chain caps
TOPO=$(node -e "
const fs=require('fs');const {PROFILES,activeNets,launchCapOf,dollarOfNet}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];
if(!p){console.error('unknown universe \"'+process.env.SPAWN_PROFILE+'\" ('+Object.keys(PROFILES).join(' | ')+')');process.exit(1)}
let st={};try{st=JSON.parse(fs.readFileSync(p.stateFile,'utf8'))}catch{}
const nets=activeNets(p);
if(!st[p.hub]||!st[p.hub].gateway){console.error('nothing deployed on '+p.hub+' — run launch.sh first');process.exit(1)}
const spokes=Object.keys(nets).filter(n=>nets[n].role==='spoke'&&st[n]&&st[n].gateway);
const missing=Object.keys(nets).filter(n=>nets[n].role==='spoke'&&!(st[n]&&st[n].gateway));
if(p.mainnet&&missing.length){console.error('not deployed: '+missing.join(', ')+' — run launch.sh first');process.exit(1)}
const caps=[p.hub,...spokes].map(n=>n+':'+launchCapOf(p,n)+':'+dollarOfNet(p,n).symbol).join(',');
console.log([p.hub,spokes.join(',')||'-',p.mainnet?1:0,nets[p.hub].rpc,caps].join(' '));
") || exit 1
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; [[ "$SPOKES" == "-" ]] && SPOKES=""
IS_MAINNET="$3"; HUB_RPC="$4"; CAPS="${5//,/ }"

if [[ "$IS_MAINNET" == "1" ]]; then
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
fi
SMOKE_ENV="SPAWN_REHEARSAL=1"
[[ -n "${SPAWN_CANARY_BUY:-}" ]] && SMOKE_ENV="SMOKE_BUY_USDC=$SPAWN_CANARY_BUY"
LOG_DIR="${SPAWN_LOG_DIR:-deployments/logs}"
MARK_DIR="${SPAWN_MARK_DIR:-deployments}"
mkdir -p "$LOG_DIR" "$MARK_DIR"

# hh <net> <script.js> — one hardhat CLI on one network; in a fork rehearsal
# every network is a local anvil fork
hh() {
  local net="$1" script="$2"
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then
    FORK="$net" SPAWN_NET="$net" npx hardhat run "scripts/$script" --network fork
  else
    npx hardhat run "scripts/$script" --network "$net"
  fi
}

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

# the hot key that stays operator + guardian: the deployer (in a fork
# rehearsal, the address the scripts impersonate — no real key signs there)
if [[ -n "${SPAWN_FORK_REHEARSAL:-}" && -n "${SPAWN_FORK_AS:-}" ]]; then
  HOT="$SPAWN_FORK_AS"
else
  HOT=$(IS_MAINNET="$IS_MAINNET" node -e "
const fs=require('fs');const {Wallet}=require('ethers');
const t=fs.readFileSync('.env','utf8');
const own=t.match(/^MAINNET_DEPLOYER_PK=(0x[0-9a-fA-F]{64})/m);
const m=(process.env.IS_MAINNET==='1'&&own)?own:t.match(/^DEPLOYER_PK=(0x[0-9a-fA-F]{64})/m);
if(!m){console.error('DEPLOYER_PK missing in contracts/.env');process.exit(1)}
process.stdout.write(new Wallet(m[1]).address)")
fi

# Proof of control. Holding the key is proof; otherwise the owner must have
# signed at least one transaction on the hub chain — an address that has
# never sent anything may be a custodial (exchange) deposit address.
lower() { echo "$1" | tr 'A-F' 'a-f'; }
if [[ -n "$LOCAL_OWNER" && "$(lower "$OWNER")" == "$(lower "$LOCAL_OWNER")" ]]; then
  echo "✓ OWNER $OWNER is the wallet in contracts/.env.owner (key held on this machine)"
else
  NONCE=$(HUB_RPC="$HUB_RPC" OWNER="$OWNER" node -e "
const {ethers}=require('ethers');
new ethers.JsonRpcProvider(process.env.HUB_RPC).getTransactionCount(process.env.OWNER).then(n=>process.stdout.write(String(n)))")
  if [[ "$NONCE" == "0" ]]; then
    echo "✗ $OWNER has never sent a transaction on the hub chain — control of it is not proven."
    echo "  Send any transaction FROM that wallet there first, then run this again."
    exit 1
  fi
  echo "✓ OWNER $OWNER has signed $NONCE transaction(s) on the hub chain"
fi

step() { printf '\n════════ %s ════════\n' "$*"; }
# logged <label> <success-regex> [VAR=value…] <command…> — output kept in a
# log file, success = exit 0 AND the line that proves it. LOG_TRIES attempts
# (default 1): the hand-over and the caps are idempotent and resume.
logged() {
  local label="$1" ok="$2"; shift 2
  local try tries="${LOG_TRIES:-1}" log
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
    if [[ "$try" != "$tries" ]]; then echo "… not clean; resuming in 20s"; sleep "${SPAWN_RETRY_SLEEP:-20}"; fi
  done
  echo "✗ $label did not finish cleanly — stopping. Full output: contracts/$log"
  echo "  (this script resumes: fix the cause and run the same command again)"
  echo "  ➜ Écris « fait » à Claude : il lira ce journal."
  exit 1
}

echo "finish — profile $PROFILE — hub $HUB — spokes ${SPOKES:-none}"

# Every chain is proved with real money before anything is handed over or
# opened. launch.sh ran them; one that could not afford it (Ethereum at an
# L1 gas spike) is tried once more here — and if it still cannot, its vault
# simply stays at the canary cap.
source scripts/lib-canary.sh # a mark is bound to the gateway it proved
UNPROVEN=""
if [[ -z "${SPAWN_SKIP_XCHAIN_CANARY:-}" ]]; then
  for n in $HUB $SPOKES; do
    if canary_passed "$n"; then continue; fi
    step "canary from $n — not passed yet: a round trip with the deployer's own money"
    log="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-canary_$n.log"
    code=0
    ( export $SMOKE_ENV; hh "$n" smoke.js ) > "$log" 2>&1 || code=$?
    tail -n 12 "$log" | cut -c1-240
    if [[ "$code" == "4" ]] && grep -q 'CANARY NOT AFFORDABLE' "$log"; then
      echo "⚠ $n: canary still not affordable — its vault stays at the canary cap"
      UNPROVEN="$UNPROVEN $n"
    elif [[ "$code" != "0" ]] || ! grep -q '🎉' "$log"; then
      echo "✗ canary $n failed — stopping. Full output: contracts/$log"
      echo "  ➜ Écris « fait » à Claude : il lira ce journal."
      exit 1
    else
      canary_record "$n"
      echo "✓ canary $n"
    fi
  done
fi

step "hand-over — OWNER $OWNER · operator/guardian $HOT"
for n in $HUB $SPOKES; do
  LOG_TRIES=4 logged "hand-over $n" 'hand-over complete' \
    SPAWN_OWNER="$OWNER" SPAWN_OPERATOR="$HOT" SPAWN_GUARDIAN="$HOT" hh "$n" handover.js
done

step "status"
hh "$HUB" status.js

step "launch deposit caps — each chain in its own dollar"
for entry in $CAPS; do
  n="${entry%%:*}"; rest="${entry#*:}"; cap="${rest%%:*}"; sym="${rest#*:}"
  if [[ " $UNPROVEN " == *" $n "* ]] || { [[ -z "${SPAWN_SKIP_XCHAIN_CANARY:-}" ]] && ! canary_passed "$n"; }; then
    echo "⚠ $n: its canary has not passed — left at the canary cap (run bash scripts/finish.sh again once it can)"
    continue
  fi
  LOG_TRIES=4 logged "set-cap $n ($cap $sym)" 'already set|setDepositCap\(' \
    SPAWN_APPLY=1 SPAWN_CAP_USDC="$cap" hh "$n" set-cap.js
done

step "status"
hh "$HUB" status.js

if [[ -n "$UNPROVEN" ]]; then
  echo
  echo "⚠ not opened yet (canary not affordable):$UNPROVEN — run  bash scripts/finish.sh  again when gas is cheaper."
fi
if [[ "$IS_MAINNET" == "1" ]]; then
  cat <<EOF

════════ HANDED OVER AND OPEN ════════
Every contract answers to the owner's 48h timelock; the hot key only tunes.
➜ Écris « fait » à Claude. Il vérifie les verrous, puis branche le site sur cet univers.
EOF
else
  printf '\n════════ REHEARSAL OF THE FINISH SCRIPT PASSED ON TESTNET ════════\n'
fi
