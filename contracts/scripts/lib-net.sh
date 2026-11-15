# Sourced by launch.sh, finish.sh, add-chain.sh and add-solana.sh.
#
# Node gives each address of a host 250 ms before it tries the next one. On a
# slow link, or one with no IPv6 route, every attempt times out and a run dies
# with EHOSTUNREACH / ETIMEDOUT in the middle of a launch (seen on the testnet
# launch of 2026-11-14). Give each attempt 5 s and try IPv4 first, for every
# node process these scripts start. A caller's own setting is left alone.
case " ${NODE_OPTIONS:-} " in
  *network-family-autoselection-attempt-timeout*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--network-family-autoselection-attempt-timeout=5000 --dns-result-order=ipv4first" ;;
esac
