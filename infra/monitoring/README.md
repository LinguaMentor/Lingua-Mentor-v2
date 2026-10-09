# Monitoring host

`setup.sh` turns a fresh Ubuntu 24.04 server into the Bugsink error-tracking host: Bugsink installed directly (SQLite, no Docker), a pinned `cloudflared` service, a nightly backup to R2 and a daily vacuum. It is one of Oracle's two free AMD Micro servers (1 GB). Nothing else runs on it.

Bugsink's data is one SQLite file, so a lost server is rebuilt and restored from the last backup, not repaired.

## What listens where

- `127.0.0.1:8000`: Bugsink, reached by the tunnel connector. The public name is `errors.<domain>`, behind Cloudflare Access.
- `<private ip>:8000`: Bugsink again, for the app servers' error events. A cloud rule and a host rule both allow only the app subnet.
- Nothing else. No ingress rule from the internet, and no SSH route in the tunnel: use the Oracle Bastion as described in `infra/staging/README.md`.

## One-time setup by hand

These survive a rebuild of the server, except step 2, which has to be redone for a new one.

1. **Domain and Access.** Create a tunnel for this server (not staging's: two servers behind one tunnel would split traffic between connectors that serve different hostnames):

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create linguamentor-monitoring
   cloudflared tunnel route dns linguamentor-monitoring errors.<domain>
   ```

   Keep `~/.cloudflared/<tunnel uuid>.json`. In Zero Trust, go to Access controls, Applications, Create new application, Self-hosted. Public hostname `errors.<domain>`, an Allow policy with the same emails as the staging application.

2. **The server.** In the Oracle console, Compute, Instances, Create instance, in the existing compartment: shape `VM.Standard.E2.1.Micro` in the one availability domain that offers it, image Canonical Ubuntu 24.04, the same VCN and subnet as staging, a public IPv4 address, your admin SSH key. Add one ingress rule to the subnet's security list: source CIDR = the subnet's own range, TCP, destination port 8000. Do not add any rule from `0.0.0.0/0`.

3. **Alerts.** New errors go to a Telegram group. In Telegram, ask @BotFather for a bot with `/newbot` and keep the token. Create a group, add the bot and the team, then get the group's chat ID from `getUpdates` (negative number). Both values go into Bugsink's web page later, not into `.env.monitoring`. Email is optional: fill the four `SMTP_*` inputs to turn it on (STARTTLS on port 587, because Oracle blocks outbound port 25). The sender address must be on a domain the provider has verified, and Resend refuses free public domains.

4. **Backups.** In Cloudflare, R2, create a private bucket. Create an API token with Object Read & Write limited to that bucket. Note the account ID, the access key ID and the secret.

## Build the host

Open a Bastion port-forwarding session to the new server's private IP on port 22 and forward it, as in `infra/staging/README.md`; add `-o ServerAliveInterval=20` to the `ssh -L` command, because the Bastion drops an idle forward. The Bastion also only accepts the IPs in its allowlist, and a session lives 3 hours. Copy the folder and the tunnel credentials over, with your inputs file:

```bash
cp .env.monitoring.example .env.monitoring   # fill it in; it is git-ignored
scp -P 2223 -i <admin key> -r infra/monitoring <tunnel uuid>.json ubuntu@127.0.0.1:
ssh -p 2223 -i <admin key> ubuntu@127.0.0.1
sudo ./monitoring/setup.sh                   # about 3 minutes
sudo bugsink-manage createsuperuser
shred -u ~/monitoring/.env.monitoring ~/<tunnel uuid>.json   # the installed copies live in /etc
```

Set `TUNNEL_CREDENTIALS_FILE` in `.env.monitoring` to `./<tunnel uuid>.json`. Running `setup.sh` again changes nothing unless an input changed, so it is also how you rotate the R2 token or upgrade (copy the two files over again first).

Then open `https://errors.<domain>`, pass Access, sign in as the superuser, and:

1. Create one project per environment (`staging` now; production's comes with its own setup). Each has its own key.
2. Add the Telegram alert: Projects, the project's megaphone icon (Alerting Settings), Add, Telegram. Enter the bot token and the chat ID, save, then press Test and check the group. The token is stored in Bugsink's database, so it is also in the backups; revoke it with @BotFather if either leaks.
3. Invite the team: open the team, then Members, Invite Member. Without email, Bugsink shows an invite link to hand over yourself.
4. Copy the project's DSN and replace the host with the private address (`http://<key>@<private ip>:8000/<project id>`). That form is what the services use.

## Checks

- **Test event:** copy `send-test-events.py` to an app server (it needs only Python 3) and run `python3 send-test-events.py <private DSN>`. It shows up in Bugsink within seconds.
- **Port scan:** from outside, `nmap -Pn -p- <public ip>` finds nothing open (add `-sU --top-ports 100` for UDP).
- **Access:** `https://errors.<domain>` asks for the Access login, then Bugsink's own login.
- **Reboot:** `sudo reboot`. Bugsink is back by itself with its events, and `sudo iptables -S INPUT` still lists the port 8000 rule.
- **Notification:** send one event with a message nobody has sent before (the script's message includes the time). The Telegram group gets a message. Bugsink only alerts for a new issue, a regression or an unmuted issue, not for each event.
- **Burst:** on a project with no events in the last 5 minutes, `python3 send-test-events.py <private DSN> 1000 4`. Watch memory with `watch -n1 free -m` on the server. The `used` column (it leaves out the file cache) must stay under 600 MB.
- **Restore:** see below.

## Runbook

**Status and logs.**

```bash
systemctl status bugsink-gunicorn bugsink-snappea cloudflared
journalctl -u bugsink-gunicorn -u bugsink-snappea -n 100
systemctl list-timers 'bugsink-*'
curl -s http://127.0.0.1:8000/health/ready
```

**Restart.** `sudo systemctl restart bugsink-snappea bugsink-gunicorn`. Both start on boot and restart on failure. Snappea restarts itself once a day by design.

**Management commands.** `sudo bugsink-manage <command>` runs as the `bugsink` user with the service settings.

**Backups.** At 02:30 UTC `bugsink-backup` copies the database with `sqlite3 .backup`, checks the copy, compresses it and uploads `bugsink-<timestamp>.sqlite3.gz` to `<bucket>/bugsink/`. Backups older than 30 days are deleted. A failed run shows in `systemctl status bugsink-backup`; nothing else alerts on it yet. Run one by hand with `sudo systemctl start bugsink-backup`.

**Restore.** On the server (a fresh one after `setup.sh`, or the same one):

```bash
sudo bugsink-restore            # the newest backup
sudo bugsink-restore bugsink-20261010T023000Z.sqlite3.gz   # or a named one
```

It stops Bugsink, keeps the old database as `db.sqlite3.before-restore-<time>`, swaps in the backup, migrates it and starts Bugsink again. A restore into a fresh server loses nothing except sessions: everyone signs in again.

**Rebuild a lost server.** Create the server (step 2 above), run `setup.sh`, then `bugsink-restore`. Skip `createsuperuser`: the accounts come back with the database. Update the `staging` secrets only if the private IP changed, because the DSN holds it.

**Upgrade Bugsink.** Change `BUGSINK_VERSION` in `setup.sh`, read the release notes, take a backup, re-run `setup.sh`. It migrates the databases before restarting.

**Retention.** Events older than 30 days are deleted by the daily `bugsink-vacuum` run (02:00 UTC), and each project keeps at most 10,000 events. Backups keep a database for 30 days more, so an event can outlive its deletion by up to that long.

**The event limit.** Bugsink accepts at most 1,000 events per project in 5 minutes (5,000 an hour), and 1,000 in 5 minutes across all projects. It answers HTTP 200 to every event, then discards the ones past the limit when it processes them. Nothing in the UI says so. A burst of 1,200 events on a fresh project stored 1,000. The SDKs never see the loss, so a sudden flat line in a project can mean a flood, not a quiet system. To raise it, set `MAX_EVENTS_PER_PROJECT_PER_5_MINUTES` and `MAX_EVENTS_PER_5_MINUTES` (the installation-wide one) in the `BUGSINK` dict in `bugsink_conf.py`, then re-run `setup.sh`. Raising only the first changes nothing while the second still caps.

**Memory.** A fresh server of this shape uses about 400 MB of its 954 MB before anything of ours runs, so `setup.sh` masks `fwupd`, `packagekit`, `udisks2`, `ModemManager` and, when no iSCSI disk exists, `multipathd` and `iscsid`. Gunicorn runs one worker with four threads, because a second worker costs about 75 MB. Measured on 2026-10-09: 465 to 500 MB used at idle, and a peak of 518 MB during a 1,000-event burst. The Oracle Cloud Agent plugins (Cloud Guard Workload Protection and Run Command, about 48 MB together) could not be disabled from the console, so they still run. Gunicorn is capped at 400 MB and snappea at 300 MB by systemd (`MemoryMax`). If either gets killed under a burst, `journalctl -k | grep -i oom` shows it.

## What was verified, and what was not

Verified on the real server on 2026-10-09: the install (2 min 57 s on a fresh server, safe to re-run), the systemd units and firewall rule, a reboot (back in 70 s with services, events, the firewall rule and the tunnel intact), the 1,000-event burst (all stored, 518 MB peak, no out-of-memory kill), the backup to R2 and a restore (6 s; a project created after the backup was gone afterwards), loading that backup into a clean local Bugsink 2.6.1 (integrity ok, all events present), a TCP scan of all 65,535 ports on the public IP (nothing open; UDP was not scanned), and Bugsink's login page loading behind Cloudflare Access. Also verified: signing in through Access, the Telegram test message, and a new error sent from the staging server (`10.0.1.75`) over the private network, which arrived as a "NEW issue" alert in the Telegram group.

Not verified: a restore onto a second brand-new server (the clean-install restore above ran on a laptop), and whether Resend or another SMTP provider works, since email is off.
