#!/bin/bash

echo "🔧 Fixing localhost setup..."

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "Current Node.js version: $(node --version)"

if [ "$NODE_VERSION" -gt "20" ]; then
    echo "⚠️  Node.js v24+ detected. Vercel CLI has compatibility issues."
    echo "📦 Switching to Node.js v20..."
    
    if command -v nvm &> /dev/null; then
        nvm install 20
        nvm use 20
        echo "✅ Switched to Node.js v20"
    else
        echo "❌ nvm not found. Please install nvm or use Node.js v20 manually."
        echo "   Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
fi

# Check if vercel is linked
if [ ! -f .vercel/project.json ]; then
    echo "🔗 Linking to Vercel project..."
    vercel link
fi

# Check environment variables
if [ ! -f .env.local ]; then
    echo "📥 Pulling environment variables..."
    vercel env pull .env.local
else
    echo "✅ .env.local exists"
fi

# Verify required vars
if grep -q "SUPABASE_URL" .env.local && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "✅ Environment variables look good"
else
    echo "⚠️  Missing required environment variables. Pulling again..."
    vercel env pull .env.local
fi

echo ""
echo "🚀 Starting dev server..."
echo "   Access at: http://localhost:3000"
echo ""
vercel dev --listen 3000


echo "🔧 Fixing localhost setup..."

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "Current Node.js version: $(node --version)"

if [ "$NODE_VERSION" -gt "20" ]; then
    echo "⚠️  Node.js v24+ detected. Vercel CLI has compatibility issues."
    echo "📦 Switching to Node.js v20..."
    
    if command -v nvm &> /dev/null; then
        nvm install 20
        nvm use 20
        echo "✅ Switched to Node.js v20"
    else
        echo "❌ nvm not found. Please install nvm or use Node.js v20 manually."
        echo "   Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
fi

# Check if vercel is linked
if [ ! -f .vercel/project.json ]; then
    echo "🔗 Linking to Vercel project..."
    vercel link
fi

# Check environment variables
if [ ! -f .env.local ]; then
    echo "📥 Pulling environment variables..."
    vercel env pull .env.local
else
    echo "✅ .env.local exists"
fi

# Verify required vars
if grep -q "SUPABASE_URL" .env.local && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "✅ Environment variables look good"
else
    echo "⚠️  Missing required environment variables. Pulling again..."
    vercel env pull .env.local
fi

echo ""
echo "🚀 Starting dev server..."
echo "   Access at: http://localhost:3000"
echo ""
vercel dev --listen 3000


echo "🔧 Fixing localhost setup..."

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "Current Node.js version: $(node --version)"

if [ "$NODE_VERSION" -gt "20" ]; then
    echo "⚠️  Node.js v24+ detected. Vercel CLI has compatibility issues."
    echo "📦 Switching to Node.js v20..."
    
    if command -v nvm &> /dev/null; then
        nvm install 20
        nvm use 20
        echo "✅ Switched to Node.js v20"
    else
        echo "❌ nvm not found. Please install nvm or use Node.js v20 manually."
        echo "   Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
fi

# Check if vercel is linked
if [ ! -f .vercel/project.json ]; then
    echo "🔗 Linking to Vercel project..."
    vercel link
fi

# Check environment variables
if [ ! -f .env.local ]; then
    echo "📥 Pulling environment variables..."
    vercel env pull .env.local
else
    echo "✅ .env.local exists"
fi

# Verify required vars
if grep -q "SUPABASE_URL" .env.local && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "✅ Environment variables look good"
else
    echo "⚠️  Missing required environment variables. Pulling again..."
    vercel env pull .env.local
fi

echo ""
echo "🚀 Starting dev server..."
echo "   Access at: http://localhost:3000"
echo ""
vercel dev --listen 3000


echo "🔧 Fixing localhost setup..."

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "Current Node.js version: $(node --version)"

if [ "$NODE_VERSION" -gt "20" ]; then
    echo "⚠️  Node.js v24+ detected. Vercel CLI has compatibility issues."
    echo "📦 Switching to Node.js v20..."
    
    if command -v nvm &> /dev/null; then
        nvm install 20
        nvm use 20
        echo "✅ Switched to Node.js v20"
    else
        echo "❌ nvm not found. Please install nvm or use Node.js v20 manually."
        echo "   Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
fi

# Check if vercel is linked
if [ ! -f .vercel/project.json ]; then
    echo "🔗 Linking to Vercel project..."
    vercel link
fi

# Check environment variables
if [ ! -f .env.local ]; then
    echo "📥 Pulling environment variables..."
    vercel env pull .env.local
else
    echo "✅ .env.local exists"
fi

# Verify required vars
if grep -q "SUPABASE_URL" .env.local && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "✅ Environment variables look good"
else
    echo "⚠️  Missing required environment variables. Pulling again..."
    vercel env pull .env.local
fi

echo ""
echo "🚀 Starting dev server..."
echo "   Access at: http://localhost:3000"
echo ""
vercel dev --listen 3000



echo "🔧 Fixing localhost setup..."

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "Current Node.js version: $(node --version)"

if [ "$NODE_VERSION" -gt "20" ]; then
    echo "⚠️  Node.js v24+ detected. Vercel CLI has compatibility issues."
    echo "📦 Switching to Node.js v20..."
    
    if command -v nvm &> /dev/null; then
        nvm install 20
        nvm use 20
        echo "✅ Switched to Node.js v20"
    else
        echo "❌ nvm not found. Please install nvm or use Node.js v20 manually."
        echo "   Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
fi

# Check if vercel is linked
if [ ! -f .vercel/project.json ]; then
    echo "🔗 Linking to Vercel project..."
    vercel link
fi

# Check environment variables
if [ ! -f .env.local ]; then
    echo "📥 Pulling environment variables..."
    vercel env pull .env.local
else
    echo "✅ .env.local exists"
fi

# Verify required vars
if grep -q "SUPABASE_URL" .env.local && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "✅ Environment variables look good"
else
    echo "⚠️  Missing required environment variables. Pulling again..."
    vercel env pull .env.local
fi

echo ""
echo "🚀 Starting dev server..."
echo "   Access at: http://localhost:3000"
echo ""
vercel dev --listen 3000


