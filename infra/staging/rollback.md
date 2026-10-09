# Rolling back staging

A rollback puts the previous set of images back and checks that they work. It never touches the database: migrations only move forward and each one works with the previous release's code, so the old images run against the new schema.

Roll back when the smoke test fails after a deploy and the automatic rollback did not run or did not fix it, or when someone finds a regression on staging that needs the last release gone. Fix forward instead when the problem is a migration that left the schema incompatible with the previous release; that needs a person to look at it first.

## What you need

- `cloudflared` installed and a Cloudflare Access login for `ssh-staging.<domain>`. Run `cloudflared access login https://ssh-staging.<domain>` once.
- Your SSH key on the `deploy` user (CI's key is not yours).
- Optionally, an Access service token to run the smoke test from your laptop (see "Check it" below).

## Steps

1. Connect as `deploy`:

   ```bash
   ssh -o ProxyCommand="cloudflared access ssh --hostname ssh-staging.<domain>" deploy@ssh-staging.<domain>
   ```

   If the tunnel or Docker is down, use the Bastion route in [README.md](README.md#if-the-tunnel-or-docker-is-down).

2. Look at what is running and what you are going back to:

   ```bash
   cd /opt/linguamentor/staging
   diff images.env images.env.previous
   ```

   `images.env` lists the four images the stack runs now, by digest. `images.env.previous` is the set it replaced. Whoever deploys keeps the file they overwrite under that name (#70 is expected to automate this). If `images.env.previous` is missing, stop: there is nothing known to go back to, and the commit to redeploy has to come from the deploy history on GitHub.

3. Swap them, keeping the bad set for the investigation:

   ```bash
   mv images.env images.env.rolled-back
   cp images.env.previous images.env
   docker compose --env-file images.env up -d --wait
   ```

   `--wait` returns only when every container reports healthy, and exits with an error if one does not. Compose recreates only the containers whose image changed, and pulls any image by digest that is no longer on the server. Healthy here means alive: it says nothing about whether the release works, which is what step 4 is for.

4. Check it, from your laptop in the repository root:

   ```bash
   SMOKE_BASE_URL=https://staging.<domain> \
   CF_ACCESS_CLIENT_ID=<service token id> CF_ACCESS_CLIENT_SECRET=<service token secret> \
   node scripts/smoke-test.mjs
   ```

   It must end with `Smoke test passed.` The variables it reads are listed in [README.md](README.md#smoke-test).

5. Tell the team which commit staging is on now, and why, in the ticket or the channel. Leave `images.env.rolled-back` in place until the cause is found.

## Rehearsal log

Each rehearsal is timed from the first command in step 2 to the passing smoke test in step 4. The time covers the commands only, not connecting to the server.

| Date | Where | Rolled back from | Rolled back to | Time | By |
| ---- | ----- | ---------------- | -------------- | ---- | -- |
| 2026-10-09 | Local stand-in (see below) | A release whose readiness returns 503 | The previous release | 21.5 s | Claude |

The staging stack is not deployed yet (#70), so this first rehearsal ran on a local copy of it: `docker-compose.yml` from this folder with only the host paths and ports changed, images pinned by digest in a local registry and pulled fresh, and the real `scripts/smoke-test.mjs`. The application images were stand-ins that honour the same endpoints, because the real API has no readiness check yet. Before the rollback the smoke test failed with `readiness ... returned 503` while Compose reported every container healthy. After it, the API and web containers were recreated on the previous images, Redis, the AI service and the worker were left alone, and the smoke test passed.

Not covered, because it needs the real server: the SSH step through Cloudflare Access (step 1) and the Access service token for the smoke test. Repeat the rehearsal on staging once #70 deploys it and add a row.
