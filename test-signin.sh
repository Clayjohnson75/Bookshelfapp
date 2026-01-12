#!/bin/bash

echo "🧪 Testing Sign-In API Endpoint"
echo "================================"
echo ""

# Replace 'claytest' with your actual username
USERNAME="claytest"

echo "1. Testing API endpoint: /api/get-email-by-username"
echo "   Username: $USERNAME"
echo ""

curl -X POST https://www.bookshelfscan.app/api/get-email-by-username \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\"}" \
  -w "\n\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" \
  --max-time 10

echo ""
echo "================================"
echo "✅ If you see an email address, the API is working"
echo "❌ If you see an error or timeout, there's an API issue"

