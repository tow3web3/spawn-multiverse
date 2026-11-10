#!/bin/zsh
# Polite devnet SOL collector: asks the standard CLI airdrop for 2 SOL every
# 30 minutes until the deploy wallet holds enough for the program deploy
# (~2.1 SOL), then exits. The rate limiter refusing is normal — we just try
# again later; faucet.solana.com (human captcha) tops up faster if available.
ADDR="EzXiHeBppPFfLsWXQrQuSJKexPq8T3xKpizfTJ3EUEt"
NEED=2.2
URL="https://api.devnet.solana.com"
for i in {1..48}; do
  BAL=$(solana balance "$ADDR" --url "$URL" 2>/dev/null | awk '{print $1}')
  echo "$(date -u +%FT%TZ) balance: ${BAL:-?} SOL"
  if [ -n "$BAL" ] && [ "$(echo "$BAL >= $NEED" | bc)" = "1" ]; then
    echo "SOL_COLLECTED: $BAL"
    exit 0
  fi
  solana airdrop 2 "$ADDR" --url "$URL" 2>&1 | tail -1
  sleep 1800
done
echo "SOL_COLLECT_TIMEOUT"
