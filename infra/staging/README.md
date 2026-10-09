# Staging host

`setup.sh` turns a fresh Ubuntu 24.04 server into a staging host: Docker, a pinned `cloudflared` service, a `deploy` user with key-only SSH, and the folders the stack runs from. `docker-compose.yml` is the staging stack. Nothing on the server listens to the internet; the tunnel is the only way in.

All state lives outside the server (Neon, object storage, a disposable Redis), so a lost server is rebuilt, not repaired.

## One-time Cloudflare setup

These survive a server rebuild. The tunnel must be created with `cloudflared tunnel create` or the API, not in the dashboard: a dashboard tunnel is remotely managed and ignores the ingress rules in `setup.sh`.

- A named tunnel. Keep its credentials JSON; it is the only secret the script needs from Cloudflare.
- Proxied CNAMEs `staging` and `ssh-staging` pointing at `<tunnel id>.cfargotunnel.com`. Both are one label under the domain, because the free certificate covers one level.
- An Access application for `staging.<domain>` with an Allow policy for the team's emails.
- An Access application for `ssh-staging.<domain>` with an Allow policy for the team and a Service Auth policy for the CI service token.
- A Service Auth policy on the `staging.<domain>` application too, so the smoke test can reach the API from CI (see "Smoke test").

## Network rules (Oracle)

- The server's security list has no ingress rule from the internet. SSH is allowed from the VCN's own range only, for the Oracle Bastion.
- Oracle's Ubuntu images end their firewall with a `REJECT` rule. Any port you open on the private network needs a cloud rule and a host rule. The stack opens none: every published port is bound to `127.0.0.1`.

## Build the host

Create the server in the app subnet with your admin SSH key, then open an Oracle Bastion port-forwarding session to its private IP on port 22 (Console, or `oci bastion session create-port-forwarding`). Forward it and copy this folder and the tunnel credentials over:

```bash
ssh -N -L 2222:<private ip>:22 -i <admin key> <session ocid>@host.bastion.<region>.oci.oraclecloud.com
scp -P 2222 -i <admin key> setup.sh docker-compose.yml <tunnel uuid>.json ubuntu@127.0.0.1:
```

Then on the server:

```bash
sudo DOMAIN=<domain> TUNNEL_ID=<tunnel uuid> \
     TUNNEL_CREDENTIALS_FILE=./<tunnel uuid>.json \
     DEPLOY_SSH_PUBKEY='ssh-ed25519 AAAA... ci' \
     ./setup.sh
```

A rebuild from nothing (new server, script, secrets, host key) took under 3 minutes, about 75 seconds of it in the script. Running it again changes nothing unless an input changed, so it is also how you rotate the CI key. It prints the server's SSH host key at the end. Store that line in the GitHub `staging` environment; a rebuild creates a new key and the secret must be updated.

## Run the stack

Until #70 does this on every merge (keep the file you replace as `images.env.previous` first, which the [rollback](rollback.md) relies on):

1. Put the app secrets in `/etc/linguamentor/staging.env` and the JWT keys in `/etc/linguamentor/keys/` (owned by `deploy`, not world-readable).
2. Write `/opt/linguamentor/staging/images.env` with `API_GATEWAY_IMAGE`, `AI_SERVICE_IMAGE`, `WORKER_IMAGE` and `WEB_IMAGE`.
3. As `deploy`: `docker compose --env-file images.env up -d`.

The web container listens on loopback port 3000 (the tunnel's `/*` route). The gateway stays on loopback 3001 (`/api/`). Build the web image with a public origin in `NEXT_PUBLIC_API_BASE_URL` (the pages run in the browser, so `http://api-gateway:3000` will not work). To check the file without the host paths: `API_GATEWAY_IMAGE=x AI_SERVICE_IMAGE=x WORKER_IMAGE=x WEB_IMAGE=x docker compose -f docker-compose.yml config`.

To run only the web service on a laptop with placeholder image names for the others (from the repo root):

```bash
docker build -f apps/frontend/Dockerfile -t linguamentor-web:local .
API_GATEWAY_IMAGE=placeholder:api-gateway \
AI_SERVICE_IMAGE=placeholder:ai-service \
WORKER_IMAGE=placeholder:worker \
WEB_IMAGE=linguamentor-web:local \
  docker compose -f infra/staging/docker-compose.yml up -d web
```

It answers on `127.0.0.1:3000`. Stop it with the same image env vars and `docker compose -f infra/staging/docker-compose.yml down`.

The `deploy` user can run Docker, which is root-equivalent, so the secrets file keeps out other local users, not a compromised deploy key.

## Check it

- From outside: `nmap -Pn -p- <public ip>` finds nothing open (add `-sU --top-ports 100` for UDP).
- `https://staging.<domain>` shows the Access login, then the app. `/api/` reaches the gateway.
- CI reaches the server with `cloudflared access ssh` and the service token; a plain `ssh` to the public IP times out.

## Smoke test

`scripts/smoke-test.mjs` checks a deployed stack the way a learner would use it: the API reports ready, a throwaway account registers and logs in, one essay goes through scoring to a finished result, and the account is erased. It needs only Node 24 and exits non-zero on the first failure, so a deploy workflow can fail on it.

```bash
SMOKE_BASE_URL=https://staging.<domain> \
CF_ACCESS_CLIENT_ID=<service token id> CF_ACCESS_CLIENT_SECRET=<service token secret> \
  node scripts/smoke-test.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMOKE_BASE_URL` | required | Origin of the stack, as the browser would see it |
| `SMOKE_READY_PATH` | `/api/v1/health/ready` | The readiness endpoint; it checks the database and Redis. The backend adds it; until then readiness fails |
| `SMOKE_READY_WAIT_SECONDS` | `30` | How long to keep retrying readiness after a deploy |
| `SMOKE_WRITING_WAIT_SECONDS` | `120` | How long to wait for the essay to be scored |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | none | Cloudflare Access service token, needed when the hostname sits behind Access |

The account is `smoke-<time>-<random>@smoke.invalid`, created for the run and erased at the end even when a step failed. Erasure clears the essay and its feedback and anonymises the user row. If the erase step fails the script says which address to remove and exits non-zero. Every run still leaves one anonymised user and one emptied writing session in the database, and costs one scoring call.

A redirect counts as a failure and is never followed. If the Access service token is missing or wrong, the first check fails with `returned 302 to <team>.cloudflareaccess.com` instead of passing on the login page.

A withheld score (`awaiting_calibration`) counts as finished. The test checks that the pipeline ran, not what the score was.

Its own tests run without a stack: `node --test scripts/smoke-test.test.mjs`.

To roll staging back when it fails, see [rollback.md](rollback.md).

## If the tunnel or Docker is down

Open a new Bastion session and forward it as above, then `ssh -p 2222 -i <admin key> ubuntu@127.0.0.1` (key-only, outside the tunnel). The Oracle serial console is the last resort.

## Upgrading cloudflared

Change `CLOUDFLARED_VERSION` and both checksums in `setup.sh` in a reviewed PR, then re-run it. The unit passes `--no-autoupdate`, so it never upgrades itself.
