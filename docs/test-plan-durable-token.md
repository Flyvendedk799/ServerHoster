# Durable API/MCP Token Test Plan

This document provides verification steps to confirm that the durable API/MCP token persists across server restarts and redeploys.

## Prerequisites

- ServerHoster instance running
- Access to the dashboard UI
- `curl` or similar HTTP client

## Test 1: Token Generation and UI Access

### Steps

1. Navigate to **Settings** → **Dev Tools** tab
2. Locate the **API / MCP Token** card
3. Verify the token shows as configured with a masked prefix (e.g., `abcd1234********************************`)
4. Click **Reveal** to show the full token
5. Click **Copy Token** to copy it to clipboard
6. Verify the token is exactly 40 characters long

### Expected Result

✅ Token is visible, copyable, and 40 characters

## Test 2: Token Authentication via REST API

### Steps

1. Copy the API token from the UI
2. Test an authenticated endpoint:

```bash
# Get system health using the durable token
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
     http://localhost:8787/settings

# Should return 200 OK with settings list
```

3. Try with an invalid token:

```bash
curl -H "Authorization: Bearer invalid-token-xyz" \
     http://localhost:8787/settings

# Should return 401 Unauthorized
```

### Expected Result

✅ Valid token returns 200
✅ Invalid token returns 401

## Test 3: Token Authentication via MCP Endpoint

### Steps

1. Copy the API token from the UI
2. Test the MCP endpoint:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0"}
    },
    "id": 1
  }'

# Should return SSE stream with serverInfo
```

### Expected Result

✅ MCP endpoint accepts the token and returns initialization response

## Test 4: Token Persists Across Restart

### Steps

1. Copy the API token: `TOKEN=$(curl -s -H "Authorization: Bearer YOUR_EXISTING_TOKEN" http://localhost:8787/settings/api-token | jq -r '.tokenPrefix')`
2. Record the token prefix (first 8 characters)
3. Stop the ServerHoster server (e.g., `Ctrl+C` or `systemctl stop survhub`)
4. Start the server again
5. Use the **same token** to authenticate:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
     http://localhost:8787/settings/api-token
```

6. Compare the token prefix

### Expected Result

✅ Same token works after restart
✅ Token prefix matches the pre-restart value

## Test 5: Token Rotation

### Steps

1. Note the current token
2. Rotate the token:

```bash
curl -X POST http://localhost:8787/settings/api-token/rotate \
  -H "Authorization: Bearer YOUR_OLD_TOKEN_HERE"

# Returns: {"ok": true, "token": "NEW_40_CHAR_TOKEN", "message": "..."}
```

3. Try using the old token:

```bash
curl -H "Authorization: Bearer YOUR_OLD_TOKEN_HERE" \
     http://localhost:8787/settings

# Should return 401 Unauthorized
```

4. Try using the new token:

```bash
curl -H "Authorization: Bearer YOUR_NEW_TOKEN_HERE" \
     http://localhost:8787/settings

# Should return 200 OK
```

### Expected Result

✅ Old token is invalidated (401)
✅ New token works (200)
✅ New token appears in the UI after rotation

## Test 6: Environment Variable Bootstrap (Fresh Install)

This test verifies that `SURVHUB_AUTH_TOKEN` seeds the durable token on first start.

### Steps

1. Stop ServerHoster
2. Delete the settings database entry:

```bash
# If using SQLite directly:
sqlite3 ~/.survhub/survhub.db "DELETE FROM settings WHERE key = 'api_token';"
```

3. Set environment variable:

```bash
export SURVHUB_AUTH_TOKEN="my-custom-bootstrap-token-123456789012"
```

4. Start ServerHoster
5. Check that the token was seeded:

```bash
curl -H "Authorization: Bearer my-custom-bootstrap-token-123456789012" \
     http://localhost:8787/settings/api-token
```

6. Verify UI shows the token

### Expected Result

✅ Token from `SURVHUB_AUTH_TOKEN` is persisted
✅ Token continues to work even if env var is cleared
✅ Subsequent restarts use the persisted token, not a regenerated one

## Test 7: MCP Client Integration (Grok Bot / Claude Desktop)

### Steps

1. Copy the token from UI
2. Configure an MCP client (e.g., Claude Desktop config):

```json
{
  "mcpServers": {
    "serverhoster": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/proxy",
        "http://localhost:8787/mcp",
        "YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

3. Start the MCP client
4. Invoke an MCP tool (e.g., "list services")
5. Stop ServerHoster
6. Restart ServerHoster (without changing the token)
7. Invoke the same MCP tool again

### Expected Result

✅ MCP client works before restart
✅ MCP client continues working after restart with the same token
✅ No need to reconfigure or re-paste the token

## Success Criteria

All tests pass, demonstrating:

- ✅ Token is generated and stored persistently
- ✅ Token works for both REST API and MCP endpoints
- ✅ Token survives server restarts
- ✅ Token can be rotated and old tokens are invalidated
- ✅ Token can be seeded from environment variable on first start
- ✅ External MCP clients work across redeploys without reconfiguration
