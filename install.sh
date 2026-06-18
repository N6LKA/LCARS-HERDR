#!/bin/bash
# LCARS Claude Interface — Install Script
set -e

INSTALL_DIR=/opt/lcars-claude
REPO=https://github.com/N6LKA/lcars-claude.git
SERVICE=lcars-claude

echo "=== LCARS Claude Interface Installer ==="

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  git -C "$INSTALL_DIR" pull
else
  echo "Cloning to $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
fi

# Install Python deps
echo "Installing dependencies..."
pip3 install -r "$INSTALL_DIR/requirements.txt" -q

# Create .env if it doesn't exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo ""
  echo "⚠️  Created $INSTALL_DIR/.env — edit it and add your ANTHROPIC_API_KEY"
  echo "    nano $INSTALL_DIR/.env"
  echo ""
fi

# Install systemd service
cp "$INSTALL_DIR/lcars-claude.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/.env and set ANTHROPIC_API_KEY"
echo "  2. Start: systemctl start $SERVICE"
echo "  3. Open:  http://$(hostname -I | awk '{print $1}'):7842"
echo ""
echo "To update later: bash $INSTALL_DIR/install.sh"
