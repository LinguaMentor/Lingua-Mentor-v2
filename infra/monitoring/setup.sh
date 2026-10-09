#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 server into the Bugsink monitoring host, safe to re-run. Inputs and usage: README.md.
set -euo pipefail

BUGSINK_VERSION=2.6.1

# Keep these in step with infra/staging/setup.sh.
CLOUDFLARED_VERSION=2026.9.3
CLOUDFLARED_SHA256_arm64=bcce0111878f13d26e66b1d2ea7f270c8bde4bd549e32ce74d32474521583ca3
CLOUDFLARED_SHA256_amd64=bc073ef293d504cf5ac533bd0aa1c824ef6b4f358765ccaa6628a8a95cacb4b7

# Ubuntu's rclone 1.60 gets a 501 from R2 on upload; bump the version and both checksums together.
RCLONE_VERSION=1.75.2
RCLONE_SHA256_arm64=b8ba161d5c837206fad79ff1aabf0a81aa02a5fb164cdbc0ff5db4160aecd278
RCLONE_SHA256_amd64=efbfe852181f7191eb3c9043ed1ab49c9b2d0ba045c61c926a5da111c939ec5c

BUGSINK_PORT=8000
BUGSINK_USER=bugsink
BUGSINK_HOME=/home/bugsink
CONF_DIR=/etc/bugsink
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
INPUTS_FILE=${INPUTS_FILE:-$SCRIPT_DIR/.env.monitoring}

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

  [[ -f $INPUTS_FILE ]] || fail "$INPUTS_FILE not found; copy .env.monitoring.example to .env.monitoring and fill it in"
  # shellcheck disable=SC1090
  . "$INPUTS_FILE"
  SMTP_HOST=${SMTP_HOST:-}
  SMTP_USER=${SMTP_USER:-}
  SMTP_PASSWORD=${SMTP_PASSWORD:-}
  MAIL_FROM=${MAIL_FROM:-}

  local name
  for name in DOMAIN TUNNEL_ID TUNNEL_CREDENTIALS_FILE APP_SUBNET_CIDR \
    R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    [[ -n ${!name:-} ]] || fail "$name is empty in $INPUTS_FILE"
  done
  # Email is optional: all four SMTP values or none of them.
  if [[ -n $SMTP_HOST$SMTP_USER$SMTP_PASSWORD$MAIL_FROM ]]; then
    for name in SMTP_HOST SMTP_USER SMTP_PASSWORD MAIL_FROM; do
      [[ -n ${!name} ]] || fail "$name is empty in $INPUTS_FILE; set all four SMTP values or none"
    done
  fi
  for name in DOMAIN TUNNEL_ID TUNNEL_CREDENTIALS_FILE APP_SUBNET_CIDR SMTP_HOST SMTP_USER SMTP_PASSWORD MAIL_FROM \
    R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    # The values land in env files that the shell and systemd both parse, inside double quotes.
    [[ ${!name} != *[\"\$\`\\]* ]] || fail "$name must not contain \" \$ \` or \\"
  done

  [[ $DOMAIN =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || fail "DOMAIN '$DOMAIN' is not a domain name"
  [[ $TUNNEL_ID =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || fail "TUNNEL_ID '$TUNNEL_ID' is not a UUID"
  [[ -f $TUNNEL_CREDENTIALS_FILE ]] || fail "$TUNNEL_CREDENTIALS_FILE does not exist"
  [[ $APP_SUBNET_CIDR =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || fail "APP_SUBNET_CIDR must look like 10.0.1.0/24"

  PUBLIC_HOSTNAME="errors.${DOMAIN}"
  PRIVATE_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')
  [[ $PRIVATE_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "could not work out the server's private IP"
}

install_prereqs() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl openssl python3 python3-venv sqlite3 iptables-persistent
}

trim_memory() {
  # The 1 GB server idles near 400 MB, so stop daemons a headless VM has no use for.
  systemctl mask --now fwupd.service fwupd-refresh.service fwupd-refresh.timer packagekit.service udisks2.service \
    ModemManager.service >/dev/null 2>&1 || true
  # Only when nothing uses iSCSI or multipath: the boot volume here is paravirtualized.
  if [[ -z $(multipath -ll 2>/dev/null) ]] && ! iscsiadm -m session >/dev/null 2>&1; then
    systemctl mask --now multipathd.service multipathd.socket iscsid.service iscsid.socket >/dev/null 2>&1 || true
  fi
}

install_rclone() {
  local arch want_sha deb
  arch=$(dpkg --print-architecture)
  case $arch in
    arm64) want_sha=$RCLONE_SHA256_arm64 ;;
    amd64) want_sha=$RCLONE_SHA256_amd64 ;;
    *) fail "no pinned rclone checksum for $arch" ;;
  esac

  if [[ $(rclone version 2>/dev/null | head -n 1) == "rclone v$RCLONE_VERSION" ]]; then
    log "rclone $RCLONE_VERSION already installed"
    return
  fi

  log "installing rclone $RCLONE_VERSION"
  deb=$(mktemp --suffix=.deb)
  curl -fsSL -o "$deb" "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.deb"
  echo "$want_sha  $deb" | sha256sum -c --quiet - || fail "rclone checksum mismatch"
  apt-get install -y -qq "$deb"
  rm -f "$deb"
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

install_bugsink() {
  id -u "$BUGSINK_USER" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$BUGSINK_USER"
  [[ -x $BUGSINK_HOME/venv/bin/python ]] || runuser -u "$BUGSINK_USER" -- python3 -m venv "$BUGSINK_HOME/venv"

  # Never run the venv's interpreter as root: the bugsink user owns it.
  if [[ $(runuser -u "$BUGSINK_USER" -- "$BUGSINK_HOME/venv/bin/python" -m pip show bugsink 2>/dev/null | awk '/^Version:/ {print $2}') == "$BUGSINK_VERSION" ]]; then
    log "bugsink $BUGSINK_VERSION already installed"
  else
    log "installing bugsink $BUGSINK_VERSION"
    runuser -u "$BUGSINK_USER" -- "$BUGSINK_HOME/venv/bin/python" -m pip install --quiet "bugsink==$BUGSINK_VERSION"
  fi
}

write_bugsink_config() {
  local secret_key=""
  install -d -m 0750 -o root -g "$BUGSINK_USER" "$CONF_DIR"
  # A new key would log everyone out, so a re-run keeps the one already on the server.
  if [[ -f $CONF_DIR/bugsink.env ]]; then
    secret_key=$(sed -n 's/^BUGSINK_SECRET_KEY="\(.*\)"$/\1/p' "$CONF_DIR/bugsink.env")
  fi
  [[ -n $secret_key ]] || secret_key=$(openssl rand -hex 32)

  {
    cat <<EOF
BUGSINK_SECRET_KEY="${secret_key}"
BUGSINK_PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME}"
BUGSINK_PRIVATE_IP="${PRIVATE_IP}"
EOF
    if [[ -n $SMTP_HOST ]]; then
      cat <<EOF
BUGSINK_SMTP_HOST="${SMTP_HOST}"
BUGSINK_SMTP_USER="${SMTP_USER}"
BUGSINK_SMTP_PASSWORD="${SMTP_PASSWORD}"
BUGSINK_MAIL_FROM="${MAIL_FROM}"
EOF
    fi
  } | write_file "$CONF_DIR/bugsink.env" 0640 "root:$BUGSINK_USER" || true

  write_file "$CONF_DIR/backup.env" 0640 "root:$BUGSINK_USER" <<EOF || true
RCLONE_S3_PROVIDER="Cloudflare"
RCLONE_S3_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
RCLONE_S3_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
RCLONE_S3_NO_CHECK_BUCKET="true"
BACKUP_REMOTE=":s3:${R2_BUCKET}/bugsink"
EOF

  write_file "$BUGSINK_HOME/bugsink_conf.py" 0644 "root:root" <"$SCRIPT_DIR/bugsink_conf.py" || true
  write_file /usr/local/bin/bugsink-backup 0755 root:root <"$SCRIPT_DIR/backup.sh" || true
  write_file /usr/local/bin/bugsink-restore 0755 root:root <"$SCRIPT_DIR/restore.sh" || true

  # Runs a management command as the bugsink user with the same settings the services use.
  write_file /usr/local/bin/bugsink-manage 0755 root:root <<EOF || true
#!/usr/bin/env bash
set -euo pipefail
set -a
. ${CONF_DIR}/bugsink.env
set +a
cd ${BUGSINK_HOME}
exec runuser -u ${BUGSINK_USER} -- ${BUGSINK_HOME}/venv/bin/bugsink-manage "\$@"
EOF
}

migrate_databases() {
  log "migrating the Bugsink databases"
  bugsink-manage migrate --verbosity 0
  bugsink-manage migrate snappea --database=snappea --verbosity 0
  bugsink-manage check_migrations
  bugsink-manage check --deploy --fail-level WARNING
}

configure_services() {
  local changed=0
  # Two binds: the tunnel connector on loopback, the app servers on the private address.
  write_file /etc/systemd/system/bugsink-gunicorn.service 0644 root:root <<EOF && changed=1
[Unit]
Description=Bugsink web server
After=network.target

[Service]
Type=notify
User=${BUGSINK_USER}
Group=${BUGSINK_USER}
EnvironmentFile=${CONF_DIR}/bugsink.env
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=${BUGSINK_HOME}
ExecStart=${BUGSINK_HOME}/venv/bin/gunicorn --bind=127.0.0.1:${BUGSINK_PORT} --bind=${PRIVATE_IP}:${BUGSINK_PORT} --workers=1 --threads=4 --timeout=30 --max-requests=1000 --max-requests-jitter=100 bugsink.wsgi
ExecReload=/bin/kill -s HUP \$MAINPID
KillMode=mixed
TimeoutStopSec=10
Restart=always
MemoryHigh=300M
MemoryMax=400M
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  write_file /etc/systemd/system/bugsink-snappea.service 0644 root:root <<EOF && changed=1
[Unit]
Description=Bugsink background tasks (snappea)
After=network.target

[Service]
User=${BUGSINK_USER}
Group=${BUGSINK_USER}
EnvironmentFile=${CONF_DIR}/bugsink.env
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=${BUGSINK_HOME}
ExecStart=${BUGSINK_HOME}/venv/bin/bugsink-runsnappea
KillMode=mixed
TimeoutStopSec=10
RuntimeMaxSec=1d
Restart=always
MemoryHigh=200M
MemoryMax=300M
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  write_file /etc/systemd/system/bugsink-vacuum.service 0644 root:root <<EOF && changed=1
[Unit]
Description=Delete Bugsink events past the age cap

[Service]
Type=oneshot
User=${BUGSINK_USER}
Group=${BUGSINK_USER}
EnvironmentFile=${CONF_DIR}/bugsink.env
WorkingDirectory=${BUGSINK_HOME}
ExecStart=${BUGSINK_HOME}/venv/bin/bugsink-manage vacuum
MemoryMax=300M
NoNewPrivileges=yes
PrivateTmp=yes
EOF

  write_file /etc/systemd/system/bugsink-vacuum.timer 0644 root:root <<'EOF' && changed=1
[Unit]
Description=Daily Bugsink vacuum

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

  write_file /etc/systemd/system/bugsink-backup.service 0644 root:root <<EOF && changed=1
[Unit]
Description=Back up the Bugsink database to R2

[Service]
Type=oneshot
User=${BUGSINK_USER}
Group=${BUGSINK_USER}
EnvironmentFile=${CONF_DIR}/backup.env
ExecStart=/usr/local/bin/bugsink-backup
MemoryMax=300M
NoNewPrivileges=yes
PrivateTmp=yes
EOF

  write_file /etc/systemd/system/bugsink-backup.timer 0644 root:root <<'EOF' && changed=1
[Unit]
Description=Nightly Bugsink backup

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable bugsink-gunicorn bugsink-snappea bugsink-vacuum.timer bugsink-backup.timer >/dev/null
  # The env file is not part of the unit, so restart on every run: it may hold a rotated secret.
  log "starting Bugsink"
  systemctl restart bugsink-snappea bugsink-gunicorn
  systemctl start bugsink-vacuum.timer bugsink-backup.timer
  ((changed)) && log "service units changed"
  return 0
}

configure_tunnel() {
  local changed=0
  id -u cloudflared >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
  install -d -m 0755 -o root -g root /etc/cloudflared

  write_file "/etc/cloudflared/${TUNNEL_ID}.json" 0400 cloudflared:cloudflared <"$TUNNEL_CREDENTIALS_FILE" && changed=1

  # No SSH route: this server is reached through the Oracle Bastion only.
  write_file /etc/cloudflared/config.yml 0644 root:root <<EOF && changed=1
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: ${PUBLIC_HOSTNAME}
    service: http://127.0.0.1:${BUGSINK_PORT}
  - service: http_status:404
EOF
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate >/dev/null

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
  systemctl enable cloudflared >/dev/null
  if ((changed)); then
    log "tunnel config changed, restarting cloudflared"
    systemctl restart cloudflared
  else
    systemctl start cloudflared
  fi
}

open_ingest_port() {
  local rule
  # Oracle's Ubuntu image ends the INPUT chain with a REJECT rule, so the accept goes in at the top.
  # A rule for a different source (an old subnet) is removed first.
  while read -ra rule; do
    iptables "${rule[@]/#-A/-D}"
  done < <(iptables -S INPUT | grep -E -- "--dport ${BUGSINK_PORT} " | grep -v -- "-s ${APP_SUBNET_CIDR} " || true)

  if ! iptables -C INPUT -p tcp -s "$APP_SUBNET_CIDR" --dport "$BUGSINK_PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp -s "$APP_SUBNET_CIDR" --dport "$BUGSINK_PORT" -j ACCEPT
  fi
  netfilter-persistent save >/dev/null
}

summary() {
  cat <<EOF

Monitoring host is ready.

Next, if this is a fresh install (not a restore):
  sudo bugsink-manage createsuperuser

Apps send events to http://<project key>@${PRIVATE_IP}:${BUGSINK_PORT}/<project id> (replace the host in the DSN
Bugsink shows with this private address). The web interface is https://${PUBLIC_HOSTNAME}.
EOF
}

preflight
install_prereqs
trim_memory
install_rclone
install_cloudflared
install_bugsink
write_bugsink_config
migrate_databases
configure_services
configure_tunnel
open_ingest_port
summary
