#!/usr/bin/env bash
# Local mode smoke test (docs/local-mode.md, "Tests and acceptance" item 3).
# Needs a running server with KERNEL_MODE=local and the image pulled, plus curl, python3 and docker.
#   TOKEN=<token from .env.local> scripts/local-smoke.sh
# TOKEN and OWNER default to the first pair of LOCAL_MCP_TOKENS when that is exported.
set -euo pipefail
shopt -s inherit_errexit
export LC_ALL=C

MCP_URL=${MCP_URL:-http://localhost:3002/mcp}
TOKEN=${TOKEN:-}
OWNER=${OWNER:-}
IFS=, read -ra pairs <<<"${LOCAL_MCP_TOKENS:-}"
for pair in "${pairs[@]}"; do
  if [[ -z $TOKEN ]]; then TOKEN=${pair#*:}; fi
  if [[ -z $OWNER && ${pair#*:} == "$TOKEN" ]]; then OWNER=${pair%%:*}; fi
done
if [[ -z $TOKEN ]]; then
  echo "FAIL setup: set TOKEN or LOCAL_MCP_TOKENS" >&2
  exit 1
fi

# Local toolsets (browsers, shell, computer, browser_files, playwright, repl,
# webmcp, replays, profiles) plus the always-on tools, sorted.
EXPECTED_TOOLS="browser_repl computer_action exec_command execute_playwright_code get_connection_context get_more_tools manage_browser_files manage_browsers manage_playwright_executors manage_profiles manage_replays submit_feedback webmcp"

RUN=$(date +%s)
PROFILE=smoke-$RUN
VALUE=v$RUN
BEFORE=$(docker ps -aq --filter label=kernel.local | sort)
TMP=$(mktemp -d)
id=0
SESSION=""
STEP=""
LIVE=""
PROFILE_CREATED=""
HTTP_PID=""

step() { STEP=$1; }
pass() {
  echo "PASS $STEP"
  STEP=""
}
fail() {
  echo "FAIL $STEP: $*" >&2
  STEP=""
  exit 1
}

# py CODE: runs Python with the last JSON-RPC result loaded as r.
py() { python3 -c "import json, sys; r = json.load(open(sys.argv[1])); $1" "$TMP/result"; }

# rpc METHOD PARAMS_JSON: writes the JSON-RPC result to $TMP/result.
rpc() {
  id=$((id + 1))
  local payload status sid hdr=()
  payload=$(python3 -c 'import json, sys; print(json.dumps({"jsonrpc": "2.0", "id": int(sys.argv[1]), "method": sys.argv[2], "params": json.loads(sys.argv[3])}))' "$id" "$1" "$2")
  if [[ -n $SESSION ]]; then hdr=(-H "mcp-session-id: $SESSION"); fi
  status=$(curl -sS --max-time 300 -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' \
    -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    "${hdr[@]}" -d "$payload")
  [[ $status == 2* ]] || fail "$1: http $status $(head -c 500 "$TMP/body")"
  sid=$(tr -d '\r' <"$TMP/headers" | awk 'tolower($1) == "mcp-session-id:" { print $2 }')
  if [[ -n $sid ]]; then SESSION=$sid; fi
  # The body is either plain JSON or SSE with "data:" lines.
  python3 - "$TMP/body" "$id" "$TMP/result" <<'PY' || fail "$1: bad json-rpc response"
import json, sys
body = open(sys.argv[1]).read()
msgs = [json.loads(l[5:]) for l in body.splitlines() if l.startswith("data:")] or [json.loads(body)]
msg = next((m for m in msgs if m.get("id") == int(sys.argv[2])), None)
if msg is None:
    sys.exit("no response for this request: " + body[:500])
if "error" in msg:
    sys.exit("json-rpc error: " + json.dumps(msg["error"]))
json.dump(msg["result"], open(sys.argv[3], "w"))
PY
}

# call TOOL ARGS_JSON: tools/call that fails on an isError result.
call() {
  rpc tools/call "{\"name\": \"$1\", \"arguments\": $2}"
  if py 'sys.exit(0 if r.get("isError") else 1)'; then
    fail "$1: $(py 'print(r["content"][0]["text"])')"
  fi
}

# pw SESSION CODE: execute_playwright_code.
pw() {
  local code
  code=$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$2")
  call execute_playwright_code "{\"session_id\": \"$1\", \"code\": $code}"
}

check_cap() {
  local n
  n=$(docker ps -q --filter label=kernel.local | wc -l)
  if ((n > 2)); then fail "$n kernel.local containers running, max 2"; fi
}

delete_browser() {
  call manage_browsers "{\"action\": \"delete\", \"session_id\": \"$1\"}"
  LIVE=""
}

assert_storage() {
  pw "$1" "$READ_JS"
  py "res = json.loads(r['content'][0]['text']); v = res.get('result') or {}; assert res.get('success') and 'smoke=$VALUE' in v.get('cookie', '') and v.get('ls') == '$VALUE' and 'local smoke page' in v.get('text', ''), res"
}

cleanup() {
  local rc=$? leftover
  set +e
  if [[ $rc -ne 0 && -n $STEP ]]; then echo "FAIL $STEP" >&2; fi
  # Subshells, because fail() exits.
  if [[ -n $LIVE ]]; then (delete_browser "$LIVE") >/dev/null 2>&1; fi
  if [[ -n $PROFILE_CREATED ]]; then
    (call manage_profiles "{\"action\": \"delete\", \"profile_name\": \"$PROFILE\"}") >/dev/null 2>&1
  fi
  if [[ -n $HTTP_PID ]]; then kill "$HTTP_PID" 2>/dev/null; fi
  # Last resort: containers of this owner that appeared during the run.
  if [[ -n $OWNER ]]; then
    leftover=$(comm -13 <(printf '%s\n' "$BEFORE") <(docker ps -aq --filter "label=kernel.local.owner=$OWNER" | sort))
    if [[ -n $leftover ]]; then
      echo "removing leftover containers: $leftover" >&2
      # shellcheck disable=SC2086 # one id per word
      docker rm -f $leftover >/dev/null
    fi
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "host http server on 0.0.0.0"
mkdir "$TMP/www"
echo '<!doctype html><title>smoke</title><p>local smoke page</p>' >"$TMP/www/index.html"
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')
python3 -m http.server --bind 0.0.0.0 --directory "$TMP/www" "$PORT" >/dev/null 2>&1 &
HTTP_PID=$!
for _ in $(seq 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 0.1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || fail "not reachable on port $PORT"
PAGE_URL="http://host.docker.internal:$PORT/"
SET_JS="await page.goto('$PAGE_URL'); await page.evaluate(() => { document.cookie = 'smoke=$VALUE; max-age=3600; path=/'; localStorage.setItem('smoke', '$VALUE'); }); return true;"
READ_JS="await page.goto('$PAGE_URL'); return await page.evaluate(() => ({ cookie: document.cookie, ls: localStorage.getItem('smoke'), text: document.body.innerText }));"
pass

step "initialize"
rpc initialize '{"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "local-smoke", "version": "1.0.0"}}'
pass

step "tools/list has exactly the local tools"
rpc tools/list '{}'
got=$(py 'print(" ".join(sorted(t["name"] for t in r["tools"])))')
[[ $got == "$EXPECTED_TOOLS" ]] || fail "expected: $EXPECTED_TOOLS got: $got"
pass

step "manage_profiles setup $PROFILE (browser with save_changes)"
PROFILE_CREATED=1
call manage_profiles "{\"action\": \"setup\", \"profile_name\": \"$PROFILE\"}"
SID=$(py 'import re; print(re.search(r"session id: (\S+)", r["content"][0]["text"]).group(1))')
LIVE=$SID
py 'assert "execute_playwright_code" in r["content"][0]["text"], r["content"][0]["text"]'
if [[ -z $OWNER ]]; then
  OWNER=$(docker ps --filter "label=kernel.local.id=$SID" --format '{{.Label "kernel.local.owner"}}')
fi
check_cap
pass

step "execute_playwright_code sets a cookie and localStorage on $PAGE_URL"
pw "$SID" "$SET_JS"
assert_storage "$SID"
pass

step "computer_action screenshot returns a png"
call computer_action "{\"session_id\": \"$SID\", \"actions\": [{\"type\": \"screenshot\"}]}"
py 'assert any(c["type"] == "image" and c["data"].startswith("iVBORw0KGgo") for c in r["content"]), "no png image"'
pass

step "exec_command ls /"
call exec_command "{\"session_id\": \"$SID\", \"command\": \"ls\", \"args\": [\"/\"]}"
py 'res = json.loads(r["content"][0]["text"]); assert res["exit_code"] == 0 and "usr" in res["stdout"].split(), res'
pass

step "manage_browsers delete saves the profile"
delete_browser "$SID"
pass

step "manage_browsers create with profile $PROFILE"
call manage_browsers "{\"action\": \"create\", \"profile_name\": \"$PROFILE\"}"
SID=$(py 'print(json.loads(r["content"][0]["text"])["browser"]["session_id"])')
LIVE=$SID
check_cap
pass

step "cookie and localStorage survived the profile round trip"
assert_storage "$SID"
pass

step "manage_browsers delete leaves no kernel.local container"
delete_browser "$SID"
left=$(comm -13 <(printf '%s\n' "$BEFORE") <(docker ps -aq --filter label=kernel.local | sort))
[[ -z $left ]] || fail "containers left: $left"
pass

step "manage_profiles delete $PROFILE"
call manage_profiles "{\"action\": \"delete\", \"profile_name\": \"$PROFILE\"}"
PROFILE_CREATED=""
pass

echo "PASS all"
