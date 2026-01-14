#!/bin/bash

echo "📊 Production Logs Viewer"
echo "========================"
echo ""
echo "Choose an option:"
echo "1. Vercel API logs (real-time)"
echo "2. Vercel API logs (last 100 lines)"
echo "3. EAS build logs"
echo "4. Open Vercel dashboard"
echo "5. Open Supabase dashboard"
echo ""
read -p "Enter option (1-5): " option

case $option in
  1)
    echo "📡 Following Vercel logs (Ctrl+C to stop)..."
    vercel logs --follow
    ;;
  2)
    echo "📋 Last 100 Vercel log lines..."
    vercel logs --limit 100
    ;;
  3)
    echo "📦 Opening EAS builds..."
    open "https://expo.dev/accounts/clayjohnson75/projects/bookshelf-scanner/builds"
    ;;
  4)
    echo "🌐 Opening Vercel dashboard..."
    open "https://vercel.com/dashboard"
    ;;
  5)
    echo "🗄️ Opening Supabase dashboard..."
    open "https://supabase.com/dashboard"
    ;;
  *)
    echo "Invalid option"
    ;;
esac

