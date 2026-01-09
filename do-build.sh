#!/usr/bin/env bash
cd /Users/clayjohnson/BookshelfScannerExpoApp
git add -A
git commit -m "Update to version 1.0.6 build 31 - Fix username sign-in with RPC and API fallback"
git push
eas build --platform ios --profile production --auto-submit

