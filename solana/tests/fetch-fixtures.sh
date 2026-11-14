#!/bin/zsh
# Pulls the REAL LayerZero V2 stack of a Solana cluster into
# tests/fixtures/<cluster>/ so the integration tests can run it locally under
# LiteSVM: the state accounts the quote / send / receive paths read, the
# worker programs that state points at (solana program dump), and — on
# mainnet — Circle's USDC mint account and its CCTP V2 programs and state.
# Idempotent; read-only RPC.
#
#   ./fetch-fixtures.sh            # mainnet (what the tests load)
#   ./fetch-fixtures.sh devnet
set -e
cd "$(dirname "$0")"
node fetch-state.cjs "${1:-mainnet}"
# Circle's CCTP V2 programs and state, for the vault's outbound leg
# (`rebalance`): mainnet only — it is what the tests load.
if [ "${1:-mainnet}" = "mainnet" ]; then node fetch-cctp.cjs; fi
