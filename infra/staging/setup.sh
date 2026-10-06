#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 server into a staging host, safe to re-run. Inputs and usage: README.md.
set -euo pipefail

# The version tested in #95; bump it and both checksums together.
CLOUDFLARED_VERSION=2026.9.3
CLOUDFLARED_SHA256_arm64=bcce0111878f13d26e66b1d2ea7f270c8bde4bd549e32ce74d32474521583ca3
CLOUDFLARED_SHA256_amd64=bc073ef293d504cf5ac533bd0aa1c824ef6b4f358765ccaa6628a8a95cacb4b7

# Host ports the tunnel forwards to; docker-compose.yml publishes the same ones.
WEB_PORT=3000
API_PORT=3001

DEPLOY_USER=deploy
APP_DIR=/opt/linguamentor/staging
CONF_DIR=/etc/linguamentor

log() { echo "==> $*"; }
fail() { echo "error: $*" >&2; exit 1; }

# Writes stdin to $1 (mode $2, owner $3) and returns 0 only if the content changed.
write_file() {
  local dest=$1 mode=$2 owner=$3 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f $dest ]] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    chown "$owner" "$dest"
    chmod "$mode" "$dest"
    return 1
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$dest"
  rm -f "$tmp"
}

preflight() {
  [[ $EUID -eq 0 ]] || fail "run as root (sudo)"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || fail "Ubuntu 24.04 only (found ${PRETTY_NAME:-unknown})"

  : "${DOMAIN:?set DOMAIN, the Cloudflare domain without a subdomain}"
  : "${TUNNEL_ID:?set TUNNEL_ID, the tunnel UUID}"
  : "${TUNNEL_CREDENTIALS_FILE:?set TUNNEL_CREDENTIALS_FILE, the tunnel credentials JSON}"
  : "${DEPLOY_SSH_PUBKEY:?set DEPLOY_SSH_PUBKEY, the public key CI logs in with}"

  [[ $DOMAIN =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || fail "DOMAIN '$DOMAIN' is not a domain name"
  [[ $TUNNEL_ID =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || fail "TUNNEL_ID '$TUNNEL_ID' is not a UUID"
  [[ -f $TUNNEL_CREDENTIALS_FILE ]] || fail "$TUNNEL_CREDENTIALS_FILE does not exist"
  [[ $DEPLOY_SSH_PUBKEY =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com)\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] \
    || fail "DEPLOY_SSH_PUBKEY must be a single ed25519 or ecdsa public key line"
}

install_prereqs() {
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
}

install_docker() {
  if dpkg -s docker-ce >/dev/null 2>&1; then
    log "docker already installed"
  else
    log "installing docker"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi

  # Without rotation, container logs fill the 50 GB boot volume.
  if write_file /etc/docker/daemon.json 0644 root:root <<'EOF'; then
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
    log "docker log rotation changed, restarting docker"
    systemctl restart docker
  fi
  systemctl enable --now docker
}

install_cloudflared() {
  local arch want_sha deb
  arch=$(dpkg --print-architecture)
  case $arch in
    arm64) want_sha=$CLOUDFLARED_SHA256_arm64 ;;
    amd64) want_sha=$CLOUDFLARED_SHA256_amd64 ;;
    *) fail "no pinned cloudflared checksum for $arch" ;;
  esac

  if [[ $(dpkg-query -W -f='${Version}' cloudflared 2>/dev/null || true) == "$CLOUDFLARED_VERSION" ]]; then
    log "cloudflared $CLOUDFLARED_VERSION already installed"
    return
  fi

  log "installing cloudflared $CLOUDFLARED_VERSION"
  deb=$(mktemp --suffix=.deb)
  curl -fsSL -o "$deb" "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}.deb"
  echo "$want_sha  $deb" | sha256sum -c --quiet - || fail "cloudflared checksum mismatch"
  apt-get install -y -qq "$deb"
  rm -f "$deb"
}

configure_tunnel() {
  local changed=0
  id -u cloudflared >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
  install -d -m 0755 -o root -g root /etc/cloudflared

  write_file "/etc/cloudflared/${TUNNEL_ID}.json" 0400 cloudflared:cloudflared <"$TUNNEL_CREDENTIALS_FILE" && changed=1

  # Both hostnames are one label under the domain: the free certificate covers one level only.
  write_file /etc/cloudflared/config.yml 0644 root:root <<EOF && changed=1
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: staging.${DOMAIN}
    path: ^/api/
    service: http://127.0.0.1:${API_PORT}
  - hostname: staging.${DOMAIN}
    service: http://127.0.0.1:${WEB_PORT}
  - hostname: ssh-staging.${DOMAIN}
    service: ssh://localhost:22
  - service: http_status:404
EOF
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate >/dev/null

  # Own unit instead of 'cloudflared service install', which fails on a second run.
  write_file /etc/systemd/system/cloudflared.service 0644 root:root <<'EOF' && changed=1
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=cloudflared
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5s
TimeoutStartSec=15
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable cloudflared
  if ((changed)); then
    log "tunnel config changed, restarting cloudflared"
    systemctl restart cloudflared
  else
    systemctl start cloudflared
  fi
}

configure_deploy_user() {
  id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"

  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  # Replaces the file, so rotating the CI key is a re-run with the new key.
  echo "$DEPLOY_SSH_PUBKEY" | write_file "/home/$DEPLOY_USER/.ssh/authorized_keys" 0600 "$DEPLOY_USER:$DEPLOY_USER" || true

  # The 10- prefix wins over cloud-init's 50-cloud-init.conf: sshd keeps the first value it reads.
  if write_file /etc/ssh/sshd_config.d/10-linguamentor.conf 0644 root:root <<'EOF'; then
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
    install -d -m 0755 /run/sshd # sshd -t needs it
    sshd -t || fail "sshd rejected the new config"
    systemctl try-reload-or-restart ssh
  fi
}

prepare_stack_dirs() {
  install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
  install -d -m 0750 -o root -g "$DEPLOY_USER" "$CONF_DIR"
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$CONF_DIR/keys"

  # Owned by the deploy user because the deploy job rewrites it from the GitHub environment secrets.
  [[ -f $CONF_DIR/staging.env ]] || install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$CONF_DIR/staging.env"

  local compose
  compose="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/docker-compose.yml"
  if [[ -f $compose ]]; then
    write_file "$APP_DIR/docker-compose.yml" 0644 "$DEPLOY_USER:$DEPLOY_USER" <"$compose" || true
  fi
}

summary() {
  cat <<EOF

Staging host is ready.

Pin this host key in the GitHub 'staging' environment (known_hosts line):
  ssh-staging.${DOMAIN} $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)

Next: put the app secrets in ${CONF_DIR}/staging.env and the JWT keys in ${CONF_DIR}/keys,
then deploy the stack as '${DEPLOY_USER}' from ${APP_DIR} (see infra/staging/README.md).
EOF
}

preflight
install_prereqs
install_docker
install_cloudflared
configure_deploy_user
configure_tunnel
prepare_stack_dirs
summary
