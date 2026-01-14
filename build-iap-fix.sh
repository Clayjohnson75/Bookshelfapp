#!/bin/bash
set -e

echo "🔨 Building iOS app with IAP fixes (build 34)"
echo "=============================================="
echo ""

cd /Users/clayjohnson/BookshelfScannerExpoApp

# Update build number
echo "📝 Updating build number to 34..."
sed -i '' 's/"buildNumber": "33"/"buildNumber": "34"/' app.config.js
sed -i '' 's/"buildNumber": "33"/"buildNumber": "34"/' app.json

echo "💾 Staging changes..."
git add -A

echo "📦 Committing changes..."
git commit -m "Fix IAP purchase error - improve react-native-iap import handling (build 34)"

echo "🚀 Pushing to remote..."
git push

echo ""
echo "🔨 Building iOS app for TestFlight..."
echo "This will take 10-20 minutes..."
eas build --platform ios --profile production --auto-submit

echo ""
echo "✅ Build submitted!"
echo "Check EAS dashboard: https://expo.dev/accounts/clayjohnson75/projects/bookshelf-scanner/builds"
echo ""
echo "After build completes:"
echo "1. Wait for TestFlight processing"
echo "2. Install new build on test device"
echo "3. Test purchase flow with sandbox account"
echo "4. Check Xcode Console for logs if issues persist"

