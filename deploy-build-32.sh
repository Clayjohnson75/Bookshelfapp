#!/bin/bash
set -e

echo "🚀 Deploying version 1.0.6 build 32"
echo "===================================="
echo ""

cd /Users/clayjohnson/BookshelfScannerExpoApp

echo "📦 Staging all changes..."
git add -A

echo "💾 Committing changes..."
git commit -m "Version 1.0.6 build 32 - Fix sign-in reliability with timeouts and error handling"

echo "🚀 Pushing to remote..."
git push

echo ""
echo "🔨 Building iOS app (this will take 10-20 minutes)..."
eas build --platform ios --profile production --auto-submit

echo ""
echo "✅ Build and submit initiated!"
echo "Check EAS dashboard for progress: https://expo.dev/accounts/clayjohnson75/projects/bookshelf-scanner/builds"

