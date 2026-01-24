#!/bin/bash
set -e
cd "$(dirname "$0")/.."
npm install
npm run build
echo ""
echo "✅ ServiceNow MCP installed successfully!"
echo ""
echo "Next steps:"
echo "1. Add to ~/.claude/user-mcps.json (see README.md)"
echo "2. Restart Claude"
echo "3. Use auth_browser tool to authenticate via SSO"
