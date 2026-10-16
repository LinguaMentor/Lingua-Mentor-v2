# Database backups and restore

Neon's free plan keeps 6 hours of history, so the staging database is also dumped every night to its own private R2 bucket and kept for 30 days. A restore from those dumps has been performed and timed (see the end of this page).

## What runs

The workflow **Back up the database** runs at 03:15 UTC every night (`.github/workflows/backup-database.yml`) and does, for each environment in its list (only `staging` today):

1. `pg_dump` in a Postgres 18 container, in custom format, over Neon's direct connection. The pooled connection can't serve `pg_dump`; the job turns a pooled URL into the direct one by dropping `-pooler` from the host.
2. Checks the archive with `pg_restore --list` and stops if it holds no table data.
3. Uploads it to R2 as `staging-<UTC time>.dump`, with the rclone version the monitoring server pins.
4. Deletes this environment's dumps older than 30 days, and only after a good upload, so a broken job never prunes the last backups away.
5. Pushes one data point, `backup_success{target="database",environment="staging"}`, to Grafana Cloud.

The Grafana rule **Database backup missing** (folder `LinguaMentor`) fires when 26 hours pass without that point, which covers a run that failed and one that never started. It reaches the team's Telegram group through the default notification policy.

The bucket is `linguamentor-staging-db-backups`, private. Dumps hold personal data: never make the bucket public, and keep its token scoped to it.

## Set up once per environment

In the GitHub environment (`staging` now):

- Variables: `R2_ACCOUNT_ID`, `R2_BACKUP_BUCKET`, `GRAFANA_PUSH_URL` (the metrics write URL ending in `/api/v1/push/influx/write`), `GRAFANA_PUSH_USER` (the metrics instance ID).
- Secrets: `DATABASE_URL` (already there for the deploy), `R2_BACKUP_ACCESS_KEY_ID` and `R2_BACKUP_SECRET_ACCESS_KEY` (an R2 API token with **Object Read & Write** on this bucket only; R2 has no write-only permission, and pruning needs delete), `GRAFANA_PUSH_TOKEN` (a token on the Grafana access policy `backup-heartbeat`, scope `metrics:write` only).

Then run the workflow once by hand and create the Grafana rule from its first data point: `absent_over_time(backup_success{target="database",environment="staging"}[26h])`, condition above 0, evaluated every minute, "no data" treated as Normal. A healthy backup makes the query return nothing, so the default no-data handling would alert every day.

## Run a backup now

GitHub, Actions, **Back up the database**, Run workflow, on `develop`. Or `gh workflow run backup-database.yml --ref develop`. The run's summary shows the file name, size and table count.

## Restore

Use this when the staging database is lost or damaged beyond what Neon's 6 hours of history can undo. It needs Docker, the pinned rclone (`bash scripts/install-rclone.sh`) and the repository.

1. **Make an empty database to restore into.** In the Neon console, project `linguamentor-staging`, open Databases and create a new one, for example `neondb_restored`, owned by the project's role. If the whole project is gone, create a new project in Frankfurt first. Copy its connection string with **Connection pooling off**.
2. **Point rclone at the bucket.** Use a token that can read this bucket:

   ```bash
   export RCLONE_S3_PROVIDER=Cloudflare RCLONE_S3_NO_CHECK_BUCKET=true
   export RCLONE_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   read -rs -p "R2 access key ID: " RCLONE_S3_ACCESS_KEY_ID; echo; export RCLONE_S3_ACCESS_KEY_ID
   read -rs -p "R2 secret access key: " RCLONE_S3_SECRET_ACCESS_KEY; echo; export RCLONE_S3_SECRET_ACCESS_KEY
   export BACKUP_ENV=staging BACKUP_REMOTE=:s3:linguamentor-staging-db-backups
   rclone lsf "$BACKUP_REMOTE"          # the dumps, oldest first
   ```

3. **Restore.** The newest dump by default; set `BACKUP_NAME=staging-<time>.dump` for an older one:

   ```bash
   read -rs -p "Direct URL of the empty database: " TARGET; echo
   bash scripts/restore-database.sh "$TARGET"
   ```

   It runs in one transaction, so a failure leaves the database empty rather than half-filled, and it prints how long it took. If the old database still answers, add `COMPARE_DATABASE_URL=<its direct URL>` to check every table's row count against it.
4. **Point staging at it.** Update the `staging` environment secret `DATABASE_URL` with the new database's URL (`gh secret set DATABASE_URL --env staging`, pasted at the prompt), then run **Deploy staging** on `develop`. The deploy writes the URL to the server and its post-deploy check must pass.
5. **Tell the team** which dump was restored and what was lost since it was taken, and keep the damaged database until the cause is known.

## Restore drill

Run **Back up the database** by hand with **Then restore the newest backup into a new database** ticked. After the backup it creates an empty database named `restore_drill_<run id>` next to the real one, restores the newest dump into it, compares every table's row count with the real database, and drops it again whatever happens. The run summary shows the time and the counts. Repeat it before launch and after any change of database provider.

| Date | Dump | Size | Tables | Restore time | Row counts | Run |
| ---- | ---- | ---- | ------ | ------------ | ---------- | --- |
| to be recorded from the first drill after this change merges | | | | | | |
