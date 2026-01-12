#!/bin/bash
set -e

cd /Users/clayjohnson/BookshelfScannerExpoApp

echo "📦 Staging all changes..."
git add -A

echo "💾 Committing changes..."
git commit -m "Fix package.json JSON syntax and update to version 1.0.6 build 31"

echo "🚀 Pushing to remote..."
git push

echo "🔨 Building and submitting iOS app..."
eas build --platform ios --profile production --auto-submit

echo "✅ Build and submit initiated!"

