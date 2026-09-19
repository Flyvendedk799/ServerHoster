#!/bin/bash
# Manual test script for memory alert webhook
# Usage: ./test-memory-alert.sh

set -e

echo "=== ServerHoster Memory Alert Test ==="
echo ""

# Configuration
API_URL="${SURVHUB_URL:-http://localhost:8787}"
AUTH_TOKEN="${SURVHUB_AUTH_TOKEN:-test-token}"

echo "1. Setting up test webhook (using webhook.site or similar)..."
echo "   Please visit https://webhook.site/ to get a test webhook URL"
echo ""
read -p "Enter your test webhook URL: " WEBHOOK_URL

echo ""
echo "2. Configuring memory alert..."
curl -X PUT "$API_URL/settings/alerts/memory" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "threshold": 1,
    "webhookUrl": "'"$WEBHOOK_URL"'",
    "webhookAuth": "Bearer test-secret-123"
  }' | jq .

echo ""
echo "3. Checking configuration..."
curl -X GET "$API_URL/settings/alerts/memory" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq .

echo ""
echo "4. Alert is configured with threshold=1% (very low to trigger immediately)"
echo "   The health check loop runs every 5 minutes."
echo "   Check your webhook URL in the next 5 minutes for the alert POST."
echo ""
echo "Expected webhook payload:"
cat << 'EOF'
{
  "event": "host_memory_threshold_crossed",
  "memoryUsedPercent": <current_value>,
  "threshold": 1,
  "hostname": "<your_hostname>",
  "checkedAt": "<ISO_timestamp>",
  "loadAvg1m": <load>,
  "disk": {
    "path": "<data_dir>",
    "usedPercent": <disk_usage>,
    "freeBytes": <free_space>
  }
}
EOF

echo ""
echo "5. Clean up (optional)..."
read -p "Delete alert configuration? (y/N): " DELETE
if [[ "$DELETE" =~ ^[Yy]$ ]]; then
  curl -X DELETE "$API_URL/settings/alerts/memory" \
    -H "Authorization: Bearer $AUTH_TOKEN" | jq .
  echo "Alert configuration deleted."
fi

echo ""
echo "Test complete!"
