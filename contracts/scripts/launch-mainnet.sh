#!/usr/bin/env bash
# The guarded launch of the CORE universe (Base + Optimism + Arbitrum).
# Kept under its first name: it is scripts/launch.sh for the profile given by
# SPAWN_LAUNCH_PROFILE (default: mainnet). See that script.
exec bash "$(dirname "$0")/launch.sh" "${SPAWN_LAUNCH_PROFILE:-mainnet}"
