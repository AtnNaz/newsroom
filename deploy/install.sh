#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/newsroom
DATA_DIR=/var/lib/newsroom
CONF_DIR=/etc/newsroom
CONF="$CONF_DIR/config.json"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Bu betik root olarak çalışmalı: sudo $0" >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js bulunamadı. Node.js 22.13 veya üstünü kurun." >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js $(node -v) eski; 22.13 veya üstü gerekli (node:sqlite için)." >&2
  exit 1
fi

if ! id newsroom >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin newsroom
  echo "• newsroom kullanıcısı oluşturuldu"
fi

install -d -m 0755 "$APP_DIR"
rm -rf "$APP_DIR/bin" "$APP_DIR/src" "$APP_DIR/public"
cp -r "$SRC/bin" "$SRC/src" "$SRC/public" "$APP_DIR/"
install -m 0644 "$SRC/package.json" "$SRC/LICENSE" "$SRC/README.md" "$APP_DIR/"
chmod 0755 "$APP_DIR/bin/newsroom.js"
echo "• dosyalar $APP_DIR klasörüne kopyalandı"

install -d -m 0700 -o newsroom -g newsroom "$DATA_DIR"
install -d -m 0750 -o root -g newsroom "$CONF_DIR"
if [[ ! -f "$CONF" ]]; then
  cat >"$CONF" <<JSON
{
  "host": "0.0.0.0",
  "port": 8077,
  "dataDir": "$DATA_DIR",
  "ollamaUrl": "http://127.0.0.1:11434",
  "baseUrl": ""
}
JSON
  chown root:newsroom "$CONF"
  chmod 0640 "$CONF"
  echo "• $CONF oluşturuldu (port 8077)"
fi

cat >/usr/local/bin/newsroom <<'WRAP'
#!/bin/sh
cmd="node --disable-warning=ExperimentalWarning /opt/newsroom/bin/newsroom.js"
if [ "$(id -u)" = 0 ]; then
  exec runuser -u newsroom -- $cmd --config /etc/newsroom/config.json "$@"
fi
exec sudo -u newsroom $cmd --config /etc/newsroom/config.json "$@"
WRAP
chmod 0755 /usr/local/bin/newsroom

install -m 0644 "$SRC/deploy/newsroom.service" /etc/systemd/system/newsroom.service
systemctl daemon-reload

has_password() {
  [[ -n "$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).passwordHash||"")}catch{}' "$CONF")" ]] && return 0
  [[ -f "$DATA_DIR/newsroom.db" ]] && runuser -u newsroom -- node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.exit(db.prepare("SELECT 1 FROM settings WHERE key = ?").get("auth.password") ? 0 : 1);' "$DATA_DIR/newsroom.db" 2>/dev/null
}

if ! has_password; then
  if [[ -t 0 ]]; then
    echo "• Giriş şifresi belirleyin (en az 8 karakter):"
    /usr/local/bin/newsroom password
  else
    echo "! Şifre belirlenmedi. Servis başlamadan önce: sudo newsroom password" >&2
  fi
fi

systemctl enable --now newsroom.service >/dev/null
systemctl restart newsroom.service
sleep 1
if systemctl is-active --quiet newsroom.service; then
  echo "✓ Newsroom çalışıyor: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||8077)' "$CONF")"
else
  echo "! Servis başlamadı: journalctl -u newsroom -n 50" >&2
  exit 1
fi
