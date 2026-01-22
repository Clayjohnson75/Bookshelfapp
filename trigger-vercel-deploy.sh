#!/bin/bash
# Script to trigger Vercel deployment by making a small change and pushing

cd /Users/clayjohnson/BookshelfScannerExpoApp

echo "🔄 Triggering Vercel deployment..."

# Make a tiny change to trigger deployment (add a comment)
echo "" >> vercel.json
echo "// Deployment triggered: $(date)" >> vercel.json

# Commit and push
git add vercel.json
git commit -m "Trigger Vercel deployment - $(date +%Y-%m-%d)" || echo "Nothing to commit"
git push origin main

echo "✅ Push complete. Vercel should detect the change and deploy."
echo "📊 Check your Vercel dashboard for deployment status."

