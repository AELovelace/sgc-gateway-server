#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="sgc-gateway"
SERVICE_USER="sgc-gateway"
INSTALL_DIR="/opt/sgc-gateway-server"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo ./scripts/install-fedora.sh"
  exit 1
fi

echo "[1/7] Installing Fedora packages..."
dnf install -y nodejs npm git

echo "[2/7] Creating service account..."
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/${SERVICE_USER} --shell /sbin/nologin "${SERVICE_USER}"
fi

echo "[3/7] Copying gateway files to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "data" \
  "${REPO_DIR}/" "${INSTALL_DIR}/"

echo "[4/7] Preparing runtime directories..."
mkdir -p "${INSTALL_DIR}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
  echo "Created ${INSTALL_DIR}/.env from template."
fi

echo "[5/7] Installing Node dependencies..."
pushd "${INSTALL_DIR}" >/dev/null
npm install --omit=dev
popd >/dev/null
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

echo "[6/7] Installing systemd service..."
install -m 0644 "${INSTALL_DIR}/deploy/sgc-gateway.service" "${SYSTEMD_UNIT}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "[7/7] Starting service when configuration is ready..."
if grep -qE '^SGC_API_KEY=$' "${INSTALL_DIR}/.env" || grep -qE '^STEAM_WEB_API_KEY=$' "${INSTALL_DIR}/.env"; then
  echo "The service was installed but not started because .env still has empty secrets."
  echo "Edit ${INSTALL_DIR}/.env, then run: systemctl restart ${SERVICE_NAME}"
else
  systemctl restart "${SERVICE_NAME}"
  systemctl --no-pager --full status "${SERVICE_NAME}" || true
fi

echo
echo "Install complete."
echo "Gateway files: ${INSTALL_DIR}"
echo "Environment file: ${INSTALL_DIR}/.env"
echo "Logs: journalctl -u ${SERVICE_NAME} -f"
