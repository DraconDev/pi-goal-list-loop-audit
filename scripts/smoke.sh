#!/usr/bin/env bash
# pi-goal-loop-audit — live integration smoke
#
# Drives a real pi session in tmux against a scratch dir and asserts on the
# .pi-gla ledger. This is the M2 "integration harness": it exercises the full
# loop (goal → agent work → complete_goal → isolated auditor → archive) with
# real models, which unit tests cannot do.
#
# Requirements: tmux, pi, a built-in provider with quota (default auditor
# model: opencode/deepseek-v4-flash-free — override with AUDITOR_MODEL).
#
# Usage:  scripts/smoke.sh [scenario]
#   scenario: goal (default) | list | draft
#
# Exit code 0 = all assertions passed.

set -uo pipefail

SCENARIO="${1:-goal}"
AUDITOR_MODEL="${AUDITOR_MODEL:-opencode/deepseek-v4-flash-free}"
EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/pi-gla-smoke-XXXX)"
SESS="gla-smoke-$$"
FAILURES=0

say()  { printf '\033[1m== %s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES+1)); }

send() { tmux send-keys -t "$SESS" "$1" Enter; }
wait_for() { # wait_for <pattern> <timeout-s>
  local pat="$1" t="$2" i
  for i in $(seq 1 "$t"); do
    if tmux capture-pane -t "$SESS" -p | grep -q "$pat"; then return 0; fi
    sleep 1
  done
  return 1
}
ledger_has() { # ledger_has <jq-ish python expr substring>
  python3 - "$1" "$WORK/.pi-gla/active.jsonl" <<'EOF'
import json, sys
needle, path = sys.argv[1], sys.argv[2]
try:
    for line in open(path):
        if needle in line:
            sys.exit(0)
except FileNotFoundError:
    pass
sys.exit(1)
EOF
}

say "setup: $WORK (auditor: $AUDITOR_MODEL)"
tmux kill-session -t "$SESS" 2>/dev/null
tmux new-session -d -s "$SESS" -x 200 -y 50 "cd '$WORK' && pi -e '$EXT_DIR'"
sleep 15
send "/goal-settings model=$AUDITOR_MODEL"
sleep 4

case "$SCENARIO" in
  goal)
    send '/goal "Create smoke.txt containing verified. Done when: grep -q verified smoke.txt"'
    say "waiting for audit + approval (up to 120s)"
    if wait_for "approved by auditor" 120; then pass "auditor approved"; else fail "no approval within 120s"; fi
    sleep 2
    if [ -f "$WORK/smoke.txt" ]; then pass "smoke.txt created"; else fail "smoke.txt missing"; fi
    if ledger_has '"approved":true'; then pass "ledger records approval"; else fail "ledger missing approval"; fi
    if ls "$WORK/.pi-gla/archive/"*.md >/dev/null 2>&1; then pass "goal archived"; else fail "archive empty"; fi
    if ledger_has '"regressionShieldPassed":true'; then pass "regression_shield recorded"; else fail "shield outcome missing"; fi
    ;;

  list)
    send '/list add "Create a.txt containing alpha. Done when: grep -q alpha a.txt"'
    sleep 3
    send '/list add "Create b.txt containing beta. Done when: grep -q beta b.txt"'
    say "waiting for BOTH queue items to complete (up to 240s)"
    if wait_for "approved by auditor" 120; then pass "item 1 approved"; else fail "item 1 not approved"; fi
    # wait for second archive file
    for i in $(seq 1 120); do
      n=$(ls "$WORK/.pi-gla/archive/"*.md 2>/dev/null | wc -l)
      [ "$n" -ge 2 ] && break
      sleep 1
    done
    n=$(ls "$WORK/.pi-gla/archive/"*.md 2>/dev/null | wc -l)
    if [ "$n" -ge 2 ]; then pass "both items archived ($n)"; else fail "only $n archived"; fi
    if [ -f "$WORK/a.txt" ] && [ -f "$WORK/b.txt" ]; then pass "both files created"; else fail "files missing"; fi
    if ledger_has '"list":\[\]'; then pass "queue drained"; else fail "queue not empty"; fi
    ;;

  draft)
    send '/goal'
    say "waiting for the agent to grill (up to 60s)"
    if wait_for "idea" 60 || wait_for "task" 5; then pass "agent is clarifying"; else fail "no clarification turn"; fi
    send 'create drafted.txt containing confirmed, done when grep -q confirmed drafted.txt passes'
    say "waiting for the Confirm dialog (up to 60s)"
    if wait_for "Yes" 60; then pass "confirm dialog shown"; else fail "no confirm dialog"; fi
    send ""   # Enter = accept
    say "waiting for audit + approval (up to 120s)"
    if wait_for "approved by auditor" 120; then pass "drafted goal approved"; else fail "no approval"; fi
    ;;

  *)
    echo "unknown scenario: $SCENARIO" >&2
    exit 2
    ;;
esac

say "teardown"
tmux kill-session -t "$SESS" 2>/dev/null
[ "${KEEP_WORK:-0}" = "1" ] || rm -rf "$WORK"

if [ "$FAILURES" -eq 0 ]; then
  say "SMOKE OK ($SCENARIO)"
  exit 0
else
  say "SMOKE FAILED ($SCENARIO): $FAILURES assertion(s)"
  exit 1
fi
