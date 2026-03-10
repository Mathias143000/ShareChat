#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SHARECHAT_APP_DIR:-/opt/ShareChat}"
USER_NAME="${SHARECHAT_USER_NAME:-sharechat}"
SERVICE_NAME="${SHARECHAT_SERVICE_NAME:-sharechat}"
ENV_FILE="${SHARECHAT_ENV_FILE:-/etc/default/sharechat}"
SERVICE_FILE="${SHARECHAT_SERVICE_FILE:-/etc/systemd/system/${SERVICE_NAME}.service}"
NODE_BIN="${SHARECHAT_NODE_BIN:-/usr/bin/node}"
INSTALL_CMD="${SHARECHAT_INSTALL_CMD:-npm install && npm run build}"
ID_BIN="${SHARECHAT_ID_BIN:-id}"
USERADD_BIN="${SHARECHAT_USERADD_BIN:-useradd}"
CHOWN_BIN="${SHARECHAT_CHOWN_BIN:-chown}"
APT_GET_BIN="${SHARECHAT_APT_GET_BIN:-apt-get}"
SUDO_BIN="${SHARECHAT_SUDO_BIN:-sudo}"
SYSTEMCTL_BIN="${SHARECHAT_SYSTEMCTL_BIN:-systemctl}"
BASH_BIN="${SHARECHAT_BASH_BIN:-bash}"
OPENSSL_BIN="${SHARECHAT_OPENSSL_BIN:-openssl}"
CERT_DIR="${SHARECHAT_CERT_DIR:-${APP_DIR}/certs}"
CERT_KEY_FILE="${SHARECHAT_CERT_KEY_FILE:-${CERT_DIR}/sharechat.key}"
CERT_CERT_FILE="${SHARECHAT_CERT_CERT_FILE:-${CERT_DIR}/sharechat.crt}"
CERT_SUBJ="${SHARECHAT_CERT_SUBJ:-/CN=ShareChat}"
CERT_DAYS="${SHARECHAT_CERT_DAYS:-365}"
CERT_BITS="${SHARECHAT_CERT_BITS:-2048}"

if ! "$ID_BIN" -u "$USER_NAME" >/dev/null 2>&1; then
  "$USERADD_BIN" -r -m -d /home/${USER_NAME} -s /usr/sbin/nologin ${USER_NAME}
fi

mkdir -p "$APP_DIR"
cp -a . "$APP_DIR/"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_KEY_FILE" ] || [ ! -f "$CERT_CERT_FILE" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo 'openssl is required to generate TLS certificates' >&2
    exit 1
  fi
  MSYS_NO_PATHCONV=1 "$OPENSSL_BIN" req -x509 -newkey rsa:${CERT_BITS} -nodes \
    -days ${CERT_DAYS} \
    -keyout "$CERT_KEY_FILE" \
    -out "$CERT_CERT_FILE" \
    -subj "$CERT_SUBJ"
fi
# Certificates are owned by the service user after chown below
$CHOWN_BIN -R ${USER_NAME}:${USER_NAME} "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  "$APT_GET_BIN" update
  "$APT_GET_BIN" install -y nodejs npm openssl
fi

if ! command -v openssl >/dev/null 2>&1; then
  "$APT_GET_BIN" update
  "$APT_GET_BIN" install -y openssl
fi

"$SUDO_BIN" -u ${USER_NAME} "$BASH_BIN" -lc "cd '$APP_DIR' && ${INSTALL_CMD}"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=3000
PUBLIC_ORIGIN=
ALLOWED_ORIGINS=
MAX_UPLOAD_MB=200
MAX_UPLOAD_FILES=20
MAX_TOTAL_UPLOADS_MB=0
CHAT_MESSAGE_TTL_HOURS=168
STALE_UPLOAD_TTL_HOURS=0
UPLOAD_CLEANUP_INTERVAL_MINUTES=0
UPLOAD_RATE_LIMIT=20
DELETE_RATE_LIMIT=10
HTTPS_KEY_FILE=${CERT_KEY_FILE}
HTTPS_CERT_FILE=${CERT_CERT_FILE}
HTTPS_PASSPHRASE=
EOF
fi

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=ShareChat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} dist/index.js
User=${USER_NAME}
Group=${USER_NAME}
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

"$SYSTEMCTL_BIN" daemon-reload
"$SYSTEMCTL_BIN" enable ${SERVICE_NAME}
"$SYSTEMCTL_BIN" restart ${SERVICE_NAME}

echo "Installed. Service status:"
"$SYSTEMCTL_BIN" status ${SERVICE_NAME} --no-pager -l | sed -n '1,25p'
echo "Web UI is running on port ${PORT:-3000}"
