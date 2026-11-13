#!/usr/bin/env bash
# After launch.sh: hand ONE universe to its owner and open it.
#
#   bash scripts/finish.sh                # the CORE universe (Base + Optimism + Arbitrum)
#   bash scripts/finish.sh bnb            # the BNB universe
#   bash scripts/finish.sh ethereum       # the Ethereum universe
#   bash scripts/finish.sh testnet        # rehearsal on the public testnets
#
# (`bash scripts/finish-mainnet.sh` is the same script for the core universe.)
#
# OWNER = the wallet in contracts/.env.owner (or SPAWN_FINISH_OWNER=0x… for a
# Safe / hardware wallet). It becomes the only proposer/executor of the 48h
# timelock that owns every contract. If nobody can sign for it, admin powers
# are gone for good — so control of it must be PROVEN: either its key is the
# one in contracts/.env.owner, or it has already sent a transaction on the
# hub chain.
#
# Roles after this script:
#   admin    = the timelock (OWNER schedules, waits 48h in public, executes)
#   operator = the deployer hot key: reply budgets, legs, deposit caps,
#              rebalancing between the universe's own vaults, unpause, resync
#   guardian = the deployer hot key: pause, veto a scheduled admin change
# Neither hot role can withdraw funds or rewire the protocol.
#
# Steps: (core) a canary round trip from the second spoke — the launch only
# crossed from the first; the hand-over on every chain; status; then the
# launch deposit caps (default 25,000 of the universe's dollar per vault).
# Resumable: finished steps are skipped or send nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-${SPAWN_LAUNCH_PROFILE:-mainnet}}"
[[ "$PROFILE" == "core" ]] && PROFILE=mainnet
if [[ "$PROFILE" =~ ^0x ]]; then
  echo "usage: bash scripts/finish.sh [mainnet|bnb|ethereum|testnet]   (another owner: SPAWN_FINISH_OWNER=0x…)"
  exit 1
fi
export SPAWN_PROFILE="$PROFILE"

TOPO=$(node -e "
const {PROFILES,activeNets}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];
if(!p){console.error('unknown universe \"'+process.env.SPAWN_PROFILE+'\" ('+Object.keys(PROFILES).join(' | ')+', or core)');process.exit(1)}
const nets=activeNets(p);
const spokes=Object.keys(nets).filter(n=>nets[n].role==='spoke'&&!nets[n].rehearsalOnly);
const live=p.launchSpokes||spokes;
console.log([p.hub,live.join(',')||'-',p.mainnet?1:0,nets[p.hub].rpc,(p.dollar&&p.dollar.symbol)||'USDC',p.universe||p.name].join(' '));
") || exit 1
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; [[ "$SPOKES" == "-" ]] && SPOKES=""
IS_MAINNET="$3"; HUB_RPC="$4"; DOLLAR="$5"; UNIVERSE="$6"
set -- $SPOKES
SPOKE_B="${2:-}"

if [[ "$IS_MAINNET" == "1" ]]; then
  export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
  SMOKE_ENV="SMOKE_BUY_USDC=${SPAWN_CANARY_BUY:-3}"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-25000}"
else
  SMOKE_ENV="SPAWN_REHEARSAL=1"
  LAUNCH_CAP="${SPAWN_LAUNCH_CAP_USDC:-500000000}"
fi
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
# (default 1): the hand-over and the caps are idempotent and resume, so a
# network blip or a lagging node is retried; a canary is never repeated.
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

echo "finish — universe $UNIVERSE (profile $PROFILE) — hub $HUB${SPOKES:+ — spokes $SPOKES} — settled in $DOLLAR"

# The launch script's canary crossed from the first spoke; the second has
# only been deployed and configured. Prove its pathway with real money
# before anything is handed over or opened.
if [[ -n "$SPOKE_B" && -z "${SPAWN_SKIP_XCHAIN_CANARY:-}" ]]; then
  source scripts/lib-canary.sh # a mark is bound to the gateway it proved
  if canary_passed "$SPOKE_B"; then
    step "canary from $SPOKE_B — already passed ($(cat "$(canary_mark_file "$SPOKE_B")"))"
  else
    step "canary — a full round trip from $SPOKE_B (the deployer's own money)"
    logged "canary $SPOKE_B (cross-chain)" '🎉' "$SMOKE_ENV" hh "$SPOKE_B" smoke.js
    canary_record "$SPOKE_B"
  fi
fi

step "hand-over — OWNER $OWNER · operator/guardian $HOT"
for n in $HUB $SPOKES; do
  LOG_TRIES=4 logged "hand-over $n" 'hand-over complete' \
    SPAWN_OWNER="$OWNER" SPAWN_OPERATOR="$HOT" SPAWN_GUARDIAN="$HOT" hh "$n" handover.js
done

show_status() {
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then hh "$HUB" status.js; else npx hardhat run scripts/status.js; fi
}
step "status"
show_status

step "launch deposit caps — $LAUNCH_CAP $DOLLAR per vault"
for n in $HUB $SPOKES; do
  LOG_TRIES=4 logged "set-cap $n" 'already set|setDepositCap\(' \
    SPAWN_APPLY=1 SPAWN_CAP_USDC="$LAUNCH_CAP" hh "$n" set-cap.js
done

step "status"
show_status

if [[ "$IS_MAINNET" == "1" ]]; then
  cat <<EOF

════════ $UNIVERSE: HANDED OVER AND OPEN ════════
Every contract answers to the owner's 48h timelock; the hot key only tunes.
➜ Écris « fait » à Claude. Il vérifie les verrous, puis branche le site sur cet univers.
EOF
else
  printf '\n════════ REHEARSAL OF THE FINISH SCRIPT PASSED ON TESTNET ════════\n'
fi
