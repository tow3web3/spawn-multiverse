#!/bin/zsh
# Pulls the REAL LayerZero V2 devnet stack into tests/fixtures/ so the
# integration tests can run it locally under LiteSVM: the five program
# binaries (solana program dump) and the state accounts (PDAs) the
# quote/send path reads. Idempotent — re-run any time; devnet reads only.
#
# Addresses from https://metadata.layerzero-api.com/v1/metadata
# (solana-testnet, eid 40168) — same endpoint address as mainnet.
set -e
cd "$(dirname "$0")"
mkdir -p fixtures
URL="https://api.devnet.solana.com"

ENDPOINT="76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6"
ULN="7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH"
EXECUTOR="6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn"
PRICEFEED="8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP"
DVN="HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW"

for pair in "endpoint:$ENDPOINT" "uln:$ULN" "executor:$EXECUTOR" "pricefeed:$PRICEFEED" "dvn:$DVN"; do
  name="${pair%%:*}"; addr="${pair#*:}"
  if [ ! -s "fixtures/$name.so" ]; then
    echo "dumping $name ($addr)…"
    solana program dump "$addr" "fixtures/$name.so" --url "$URL"
  else
    echo "fixtures/$name.so already present"
  fi
done

# State accounts: derive the PDAs and snapshot them with their owners.
node fetch-state.cjs
echo "FIXTURES_OK"
