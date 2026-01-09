#!/bin/bash
set -e

cd /Users/clayjohnson/BookshelfScannerExpoApp

echo "📦 Staging all changes..."
git add -A

echo "💾 Committing changes..."
git commit -m "Update to version 1.0.6 build 31 - Fix username sign-in with RPC and API fallback"

echo "🚀 Pushing to remote..."
git push

echo "🔨 Building iOS app..."
eas build --platform ios --profile production --auto-submit

echo "✅ Build and submit initiated!"

