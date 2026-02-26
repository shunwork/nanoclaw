---
name: refresh-heptabase-token
description: Refresh the Heptabase MCP OAuth token. Checks token expiry, guides re-authorization if expired. Triggers on "refresh heptabase", "heptabase token", "renew heptabase", "heptabase expired".
user-invocable: true
---

# Refresh Heptabase Token

Heptabase MCP uses OAuth 2.0 with a **2-day access token** and **no refresh token**. When the token expires, the agent loses access to all `mcp__heptabase__*` tools. This skill checks the token status and guides re-authorization.

See [docs/heptabase-mcp-investigation.md](/docs/heptabase-mcp-investigation.md) for full investigation details.

## Step 1: Check Token Status

Read the token file and check expiry:

```bash
TOKEN_FILE=$(ls ~/.mcp-auth/mcp-remote-*/ff*_tokens.json 2>/dev/null | head -1)
```

If no token file exists, skip to Step 3 (first-time auth needed).

Parse the JWT access token to check expiry:

```bash
python3 -c "
import json, base64, datetime, sys
tokens = json.load(open('$TOKEN_FILE'))
at = tokens.get('access_token', '')
parts = at.split('.')
if len(parts) != 3:
    print('STATUS: INVALID (not a JWT)')
    sys.exit(0)
payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=='))
exp = payload.get('exp', 0)
exp_dt = datetime.datetime.fromtimestamp(exp, tz=datetime.timezone.utc)
now = datetime.datetime.now(tz=datetime.timezone.utc)
remaining = exp_dt - now
hours = remaining.total_seconds() / 3600
if remaining.total_seconds() <= 0:
    print(f'STATUS: EXPIRED (since {-hours:.1f}h ago)')
elif hours < 6:
    print(f'STATUS: EXPIRING_SOON ({hours:.1f}h remaining)')
else:
    print(f'STATUS: VALID ({hours:.1f}h remaining, expires {exp_dt.isoformat()})')
print(f'HAS_REFRESH_TOKEN: {bool(tokens.get(\"refresh_token\"))}')
"
```

Report the status to the user:
- **VALID**: Token is fine, no action needed. Tell the user how many hours remain.
- **EXPIRING_SOON**: Token expires within 6 hours. Recommend refreshing now.
- **EXPIRED**: Token has expired. Must re-authorize.
- **INVALID**: Token file is corrupted. Must re-authorize.

If STATUS is VALID and the user didn't explicitly ask to refresh, stop here.

## Step 2: Clean Up Old Token Cache

Before re-authorizing, remove stale token files to avoid mcp-remote using cached invalid tokens:

```bash
rm -f ~/.mcp-auth/mcp-remote-*/*_tokens.json
rm -f ~/.mcp-auth/mcp-remote-*/*_code_verifier.txt
```

**重要**：保留 `_client_info.json`，不要刪除。它記錄了 OAuth client registration，Heptabase OAuth server 會認得，讓後續 re-auth 可以靜默完成（不需要瀏覽器手動授權）。刪掉的話下次就需要重新手動授權一次。

## Step 3: Re-authorize

Tell the user:

> Running mcp-remote to start the OAuth flow. Your browser will open to Heptabase's authorization page.
> Please authorize the access, then come back here and confirm.

Run the auth command with a timeout. mcp-remote will start an HTTP server, open the browser, and wait for the OAuth callback:

```bash
timeout 120 npx -y mcp-remote@latest https://api.heptabase.com/mcp --transport http-only
```

**Note**: mcp-remote will keep running after auth completes (it's an MCP server). It's expected to `ctrl+c` or timeout after the token is saved. The token is persisted as soon as the OAuth callback completes.

If the command times out or the user confirms authorization is done, check that the token file was created:

```bash
ls -la ~/.mcp-auth/mcp-remote-*/*_tokens.json
```

## Step 4: Verify New Token

Re-run the token check from Step 1 to confirm the new token is valid.

Report to the user:
- New token expiry time
- Reminder that it will expire in ~2 days
- The container will pick up the new token on next startup (via `~/.mcp-auth/` mount)

## Step 5: Restart Container (Optional)

If the agent is currently running with an expired token, it needs a session reset to pick up the new token:

Ask the user if they want to reset the current session so the agent picks up the new token immediately. If yes:

```bash
# Write a new_session IPC task to trigger session reset
TIMESTAMP=$(date +%s%3N)
echo '{"type":"new_session","groupFolder":"main"}' > ~/Projects/nanoclaw/data/ipc/main/tasks/${TIMESTAMP}-refresh-token.json
```

This will make the host reset the session, and the next container startup will load the fresh token.

## Troubleshooting

- **Browser doesn't open**: Copy the URL from the terminal output and open it manually
- **"Port already in use"**: Another mcp-remote instance is running. Kill it: `pkill -f mcp-remote`
- **Token file not created after auth**: Check `~/.mcp-auth/` permissions. The directory needs to be writable.
- **Container still can't use Heptabase after refresh**: Verify the mount exists in `src/container-runner.ts` (search for `.mcp-auth`). The container needs to restart to pick up the new token — either wait for idle timeout or trigger a session reset.
