#!/bin/bash

echo "Setting up localhost development..."

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    npm install -g vercel
fi

# Link project if not already linked
if [ ! -f .vercel/project.json ]; then
    echo "Linking project to Vercel..."
    vercel link
fi

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo "Pulling environment variables from Vercel..."
    vercel env pull .env.local
fi

# Start dev server
echo "Starting local dev server on http://localhost:3000..."
vercel dev --listen 3000


echo "Setting up localhost development..."

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    npm install -g vercel
fi

# Link project if not already linked
if [ ! -f .vercel/project.json ]; then
    echo "Linking project to Vercel..."
    vercel link
fi

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo "Pulling environment variables from Vercel..."
    vercel env pull .env.local
fi

# Start dev server
echo "Starting local dev server on http://localhost:3000..."
vercel dev --listen 3000


echo "Setting up localhost development..."

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    npm install -g vercel
fi

# Link project if not already linked
if [ ! -f .vercel/project.json ]; then
    echo "Linking project to Vercel..."
    vercel link
fi

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo "Pulling environment variables from Vercel..."
    vercel env pull .env.local
fi

# Start dev server
echo "Starting local dev server on http://localhost:3000..."
vercel dev --listen 3000


echo "Setting up localhost development..."

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    npm install -g vercel
fi

# Link project if not already linked
if [ ! -f .vercel/project.json ]; then
    echo "Linking project to Vercel..."
    vercel link
fi

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo "Pulling environment variables from Vercel..."
    vercel env pull .env.local
fi

# Start dev server
echo "Starting local dev server on http://localhost:3000..."
vercel dev --listen 3000


echo "Setting up localhost development..."

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    npm install -g vercel
fi

# Link project if not already linked
if [ ! -f .vercel/project.json ]; then
    echo "Linking project to Vercel..."
    vercel link
fi

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo "Pulling environment variables from Vercel..."
    vercel env pull .env.local
fi

# Start dev server
echo "Starting local dev server on http://localhost:3000..."
vercel dev --listen 3000

