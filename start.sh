#!/bin/bash

# MiraViewer Startup Script

set -e

echo "🧠 Starting MiraViewer..."
echo ""

# Check if Python virtual environment exists
if [ ! -d "backend/venv" ]; then
    echo "📦 Creating Python virtual environment..."
    python3 -m venv backend/venv
    source backend/venv/bin/activate
    pip install -r backend/requirements.txt
else
    source backend/venv/bin/activate
fi

# Check if node_modules exists
if [ ! -d "frontend/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd frontend && npm install && cd ..
fi

echo ""
echo "🚀 Starting backend server..."
cd backend
python main.py &
BACKEND_PID=$!
cd ..

echo "🚀 Starting frontend dev server..."

# Vite only exposes environment variables to the browser when they're prefixed (VITE_*) unless configured.
# If you already export GOOGLE_API_KEY/GEMINI_API_KEY in your shell (e.g. ~/.zshrc), map it through.
if [ -z "${VITE_GOOGLE_API_KEY}" ]; then
    export VITE_GOOGLE_API_KEY="${GOOGLE_API_KEY:-${GEMINI_API_KEY}}"
fi

cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ MiraViewer is running!"
echo "   Frontend: http://localhost:6173"
echo "   Backend:  http://localhost:9000"
echo ""
echo "Press Ctrl+C to stop both servers"

# Handle cleanup on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT

# Wait for both processes
wait
