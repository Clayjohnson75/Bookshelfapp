#!/bin/bash

echo "Testing get-email-by-username endpoint..."
echo ""

curl -X POST https://bookshelfscan.app/api/get-email-by-username \
  -H "Content-Type: application/json" \
  -d '{"username":"claytest"}' \
  -w "\n\nHTTP Status: %{http_code}\nTotal Time: %{time_total}s\n" \
  -v

echo ""
echo "Done!"

