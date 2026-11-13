#!/usr/bin/env bash
# Hand-over and launch caps of the CORE universe (Base + Optimism + Arbitrum).
# Kept under its first name: it is scripts/finish.sh for the profile given by
# SPAWN_LAUNCH_PROFILE (default: mainnet). See that script.
exec bash "$(dirname "$0")/finish.sh" "${SPAWN_LAUNCH_PROFILE:-mainnet}"
