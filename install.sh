#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/ShareChat"
USER_NAME="sharechat"
SERVICE_NAME="sharechat"
ENV_FILE="/etc/default/sharechat"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  useradd -r -m -d /home/${USER_NAME} -s /usr/sbin/nologin ${USER_NAME}
fi

mkdir -p "$APP_DIR"
cp -a . "$APP_DIR/"
chown -R ${USER_NAME}:${USER_NAME} "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  apt-get update
  apt-get install -y nodejs npm
fi

sudo -u ${USER_NAME} bash -lc "cd '$APP_DIR' && npm install"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=3000
TTL_HOURS=24
MAX_FILE_MB=100
ALLOWED_IPS=
ADMIN_TOKEN=
EOF
fi

cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=ShareChat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/default/sharechat
WorkingDirectory=/opt/ShareChat
ExecStart=/usr/bin/node server.js
User=sharechat
Group=sharechat
Environment=NODE_ENV=production
Restart=always
RestartSec=1
StandardOutput=journal
StandardError=journal
NoNewPrivileges=false
PrivateTmp=false
ProtectSystem=off
ProtectHome=false

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

echo "Installed. Service status:"
systemctl status ${SERVICE_NAME} --no-pager -l | sed -n '1,25p'
echo "Web UI is running on port ${PORT:-3000}"