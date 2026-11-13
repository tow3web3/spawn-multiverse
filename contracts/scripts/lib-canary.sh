# Sourced by launch.sh, finish.sh and add-chain.sh (needs SPAWN_PROFILE
# exported and MARK_DIR set; run from contracts/).
#
# A canary mark records WHICH deployment passed: the gateway address on that
# network. A redeploy puts a new gateway in the state file, so it never
# inherits the canary of the deployment it replaced — a mark left behind by a
# retired version is simply ignored and overwritten.

# canary_gateway <net> — the gateway in this universe's state file, "-" if none
canary_gateway() {
  NET="$1" node -e "
const {PROFILES}=require('./config/profiles');const fs=require('fs');
const p=PROFILES[process.env.SPAWN_PROFILE];
let s={};try{s=JSON.parse(fs.readFileSync(p.stateFile,'utf8'))}catch{}
process.stdout.write(String((s[process.env.NET]||{}).gateway||'-'))"
}

canary_mark_file() { echo "$MARK_DIR/.canary-$SPAWN_PROFILE-$1.ok"; }

# canary_passed <net> — true only when the mark names the gateway deployed now
canary_passed() {
  local file gw
  file="$(canary_mark_file "$1")"
  [[ -f "$file" ]] || return 1
  gw="$(canary_gateway "$1")" || return 1
  [[ "$gw" =~ ^0x[0-9a-fA-F]{40}$ ]] || return 1
  grep -qiF -- "$gw" "$file"
}

# canary_record <net> — after a canary that passed
canary_record() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $(canary_gateway "$1")" > "$(canary_mark_file "$1")"
}
