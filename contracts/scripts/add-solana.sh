#!/usr/bin/env bash
# Adds SOLANA (label 1) to the universe — the HUB side (solana/V7.md §7; the
# Solana side is solana/scripts/wire.ts).
#
#   bash scripts/add-solana.sh testnet --store <key> --peer <key> [--vault <key>] [--prepays <file.json>] [--send]
#   bash scripts/add-solana.sh mainnet --store <key> --peer <key> [--vault <key>] [--prepays <file.json>] [--send]
#
#   --store    the gateway's OApp store (32-byte hex or base58): the pad's gateway 1
#   --peer     what the hub adapter believes for the Solana eid (default: the store)
#   --vault    the gateway's USDC vault: named a CCTP peer of the hub chain's vault, FOREVER
#   --prepays  what the Solana side prepays (JSON: returnUnit in hub wei, tradeLegs,
#              openLegs, spawnLegs, moveLegs {label: legs}); without it they are read
#              through the gateway's client (solana/app) when the program answers
#   --send     send it (default: DRY — the plan, every target and calldata, nothing sent)
#
# What it does on the hub, in order (scripts/lib-solana.js):
#   operator   setDestination(1, 400000 compute units, 3000000 LAMPORTS) [+ setSyncCap(1) if the profile wants one]
#   delegate   the executor's message size toward the Solana eid (LayerZero's default
#              toward Solana mainnet admits 200 bytes; a hub message is 288–512), and on
#              mainnet our verifier set on both sides of the pathway, libraries pinned
#   admin      [vault.setPeer(1, 5, vault)], adapter.setRoute(1, eid, peer), pad.setGateway(1, store) — LAST
# DIRECT while the deployer is still the hub's admin (the testnet today; mainnet before
# finish.sh). After the hand-over: the operator steps are sent, the rest is ONE batch on the
# hub's 48h timelock, scheduled by OWNER; run the SAME command again after the delay — it
# executes the batch, then goes on.
# Then, once pad.gateways(1) is set: tune-fees on every EVM chain then the hub, twice (moves
# toward Solana priced on every gateway, Solana's SYNC in every spawnLegs, requestCap(1, 10)
# and (1, 12), the hub-bound gas), and status. It prints what the SOLANA side must prepay —
# the figures for solana/scripts/wire.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-}"
shift || true
case "$PROFILE" in testnet|mainnet) ;; *) echo "usage: bash scripts/add-solana.sh <testnet|mainnet> --store <key> --peer <key> [--vault <key>] [--prepays <file>] [--send]"; exit 1 ;; esac
export SPAWN_PROFILE="$PROFILE"
SEND=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --store) export SOLANA_STORE="$2"; shift 2 ;;
    --peer) export SOLANA_PEER="$2"; shift 2 ;;
    --vault) export SOLANA_VAULT="$2"; shift 2 ;;
    --prepays) export SOLANA_PREPAYS="$2"; shift 2 ;;
    --send) SEND=1; shift ;;
    *) echo "unknown argument $1"; exit 1 ;;
  esac
done
[[ -n "${SOLANA_STORE:-}" ]] || { echo "--store is required"; exit 1; }
export SOLANA_PEER="${SOLANA_PEER:-$SOLANA_STORE}"

if [[ "$PROFILE" == "mainnet" && -f deployments/HOLD-MAINNET && "${SPAWN_IGNORE_HOLD:-}" != "1" ]]; then
  echo "✗ mainnet on hold:"; sed 's/^/    /' deployments/HOLD-MAINNET; exit 1
fi
if [[ "$SEND" == "1" ]]; then
  export SPAWN_SEND=1
  [[ "$PROFILE" == "mainnet" ]] && export SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY
fi

TOPO=$(node -e "
const fs=require('fs');const {PROFILES,activeNets}=require('./config/profiles');
const p=PROFILES[process.env.SPAWN_PROFILE];let st={};try{st=JSON.parse(fs.readFileSync(p.stateFile,'utf8'))}catch{}
const nets=activeNets(p);const spokes=Object.keys(nets).filter(n=>nets[n].role==='spoke'&&st[n]&&st[n].gateway);
console.log([p.hub,spokes.join(',')||'-',st[p.hub]&&st[p.hub].handover?1:0].join(' '))")
set -- $TOPO
HUB="$1"; SPOKES="${2//,/ }"; [[ "$SPOKES" == "-" ]] && SPOKES=""; HANDED="$3"

hh() {
  local net="$1" script="$2"
  if [[ -n "${SPAWN_FORK_REHEARSAL:-}" ]]; then FORK="$net" SPAWN_NET="$net" npx hardhat run "scripts/$script" --network fork
  else npx hardhat run "scripts/$script" --network "$net"; fi
}
step() { printf '\n════════ %s ════════\n' "$*"; }

WAY="direct (the deployer is the hub's admin)"; [[ "$HANDED" == "1" ]] && WAY="through the hub's timelock"
echo "add-solana — profile $PROFILE — hub $HUB — EVM spokes ${SPOKES:-none} — $WAY — $([[ "$SEND" == 1 ]] && echo SENDING || echo DRY RUN)"

if [[ "$SEND" == "1" && "$HANDED" == "1" ]]; then
  step "the timelock: execute what is ready"
  code=0
  SPAWN_OPS=execute SPAWN_TOPUP=1 hh "$HUB" timelock-ops.js || code=$?
  if [[ "$code" == "3" ]]; then echo "⏳ a batch is still inside its delay — run this command again after the time shown above."; exit 3; fi
  [[ "$code" == "0" ]] || exit "$code"
fi

step "the hub side of Solana"
log="$(mktemp)"
code=0
SPAWN_TOPUP=1 hh "$HUB" add-solana.js 2>&1 | tee "$log" || code=${PIPESTATUS[0]}
if [[ "$code" == "3" ]]; then echo "⏳ scheduled: run this command again once the delay has passed."; exit 3; fi
[[ "$code" == "0" ]] || exit "$code"
if [[ "$SEND" != "1" ]]; then echo; echo "DRY RUN — add --send to send exactly the above."; exit 0; fi
if ! grep -q 'Solana is wired on the hub' "$log"; then echo "✗ the gateway is not wired yet"; exit 1; fi

step "prices: every EVM chain, then the hub — twice"
for round in 1 2; do
  for n in $SPOKES; do SPAWN_APPLY=1 hh "$n" tune-fees.js | tail -n 20; done
  SPAWN_APPLY=1 hh "$HUB" tune-fees.js | tail -n 30
done

step "status"
hh "$HUB" status.js || true
cat <<EOF

════════ SOLANA IS WIRED ON THE HUB ════════
Next, on the Solana side (solana/scripts/wire.ts): the prepays printed above, unpause the
store, then the canary from Solana (npm run cli in solana/).
EOF
