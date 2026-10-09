# Bugsink settings for the monitoring server. Hostnames and secrets come from /etc/bugsink/bugsink.env.
import os

from bugsink.conf_utils import deduce_allowed_hosts
from bugsink.settings.default import *

SECRET_KEY = os.environ["BUGSINK_SECRET_KEY"]
PUBLIC_HOSTNAME = os.environ["BUGSINK_PUBLIC_HOSTNAME"]
PRIVATE_IP = os.environ["BUGSINK_PRIVATE_IP"]

# TLS ends at Cloudflare, which sends X-Forwarded-Proto; the cloudflared connector is the only client of that header.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# The app servers post to the private IP, so it is a valid Host next to the public name.
ALLOWED_HOSTS = deduce_allowed_hosts(f"https://{PUBLIC_HOSTNAME}") + [PRIVATE_IP]

DATABASES["default"]["NAME"] = "/home/bugsink/db.sqlite3"
DATABASES["snappea"]["NAME"] = "/home/bugsink/snappea.sqlite3"

TIME_ZONE = "UTC"

SNAPPEA = {
    "TASK_ALWAYS_EAGER": False,
    "NUM_WORKERS": 2,
    "PID_FILE": None,
    "WAKEUP_CALLS_DIR": "/home/bugsink/snappea/wakeup",
    "STATS_RETENTION_MINUTES": 60 * 24 * 7,
}

# Without an SMTP host, mail is only logged and alerts go to a chat webhook set up in the UI.
if os.environ.get("BUGSINK_SMTP_HOST"):
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = os.environ["BUGSINK_SMTP_HOST"]
    EMAIL_PORT = 587
    EMAIL_USE_TLS = True
    EMAIL_HOST_USER = os.environ["BUGSINK_SMTP_USER"]
    EMAIL_HOST_PASSWORD = os.environ["BUGSINK_SMTP_PASSWORD"]
    SERVER_EMAIL = DEFAULT_FROM_EMAIL = os.environ["BUGSINK_MAIL_FROM"]
else:
    EMAIL_BACKEND = "bugsink.email_backends.QuietConsoleEmailBackend"

CB_ADMINS = "CB_ADMINS"

BUGSINK = {
    "BASE_URL": f"https://{PUBLIC_HOSTNAME}",
    "SITE_TITLE": "LinguaMentor errors",
    # Accounts are created by an admin from the UI; nobody signs themselves up.
    "USER_REGISTRATION": CB_ADMINS,
    "SINGLE_TEAM": True,
    "TEAM_CREATION": CB_ADMINS,
    "PHONEHOME": False,
    # Alerts may only go to Telegram, so a mistyped webhook cannot reach anything else.
    "ALERTS_WEBHOOK_OUTBOUND_MODE": "allowlist_only",
    "ALERTS_WEBHOOK_ALLOW_LIST": ["api.telegram.org"],
    # Error events can carry personal data. The age cap is applied by the daily vacuum timer, not at ingest.
    "MAX_EVENT_AGE_DAYS": 30,
    "MAX_RETENTION_PER_PROJECT_EVENT_COUNT": 10_000,
    "INGEST_STORE_BASE_DIR": "/home/bugsink/ingestion",
}
