# Deploying InvokeBoard to a server: quick guide

This guide takes you from an empty Linux server to a running InvokeBoard, with the existing team data
moved over. Plan on about 30–45 minutes. You don't need to know how the app works inside. For the
background behind each step, see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## What you're setting up

InvokeBoard runs as five Docker containers on one server:

| Container | What it does |
|---|---|
| `web` | The dashboard people open in their browser |
| `jira` | Talks to Jira and holds the team's data (leaves, retros, notes, accounts…) |
| `github` | Talks to GitHub (pull requests) |
| `mysql` | The database where `jira` keeps that data |
| `cloudflared` | Makes the dashboard reachable from the internet without opening any ports |

You start and stop all five together with one command.

---

## Before you start: what you need

**A server**
- Ubuntu or Debian Linux, at least **2 GB RAM** and **10 GB disk**
- SSH access with a user that can run `sudo`

**From the project owner.** Ask for these two items **separately**, by two different channels (for
example one by email and one by chat):

1. **The data file** `invokeboard-export-<date>.json`. It contains everyone's existing data.
2. **The secret settings**: Jira and GitHub tokens, `TOKEN_ENC_KEY`, `SESSION_SECRET`, and the
   Cloudflare tunnel token (`CF_TUNNEL_TOKEN`).

> ⚠️ **Why separately?** The data file contains people's saved login tokens, encrypted, and
> `TOKEN_ENC_KEY` is the key that decrypts them. Anyone who gets both has everyone's tokens. Never
> put them in the same message, folder, or backup.

---

## Step 1: Install Docker

SSH into the server and run:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in, so your user can run Docker without `sudo`. Then check it works:

```bash
docker compose version
```

✅ You should see a version number, e.g. `Docker Compose version v2.x`.

---

## Step 2: Download the app

```bash
sudo mkdir -p /opt/invokeboard && sudo chown $USER /opt/invokeboard
git clone https://github.com/jrglomar/invokeboard.git /opt/invokeboard
cd /opt/invokeboard
```

From now on, run every command from inside `/opt/invokeboard`.

---

## Step 3: Fill in the settings

Copy the template and open it in an editor:

```bash
cp .env.prod.example .env
chmod 600 .env
nano .env
```

Fill in each value. The file has a comment next to each one. The important ones:

| Setting | Where it comes from |
|---|---|
| `JIRA_*`, `GITHUB_*` | From the project owner |
| `TOKEN_ENC_KEY`, `SESSION_SECRET` | From the project owner. **Paste exactly as given. Do not generate new ones.** |
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | Make them yourself: run `openssl rand -hex 24` twice and paste one result into each |
| `CF_TUNNEL_TOKEN` | From the project owner |

Save and exit (in nano: `Ctrl+O`, `Enter`, `Ctrl+X`).

> ⚠️ If `TOKEN_ENC_KEY` doesn't match the old one exactly, everyone's saved Jira/GitHub connections
> stop working and they'll have to reconnect.

---

## Step 4: Put the data file on the server

Run this **from your own computer**, not the server. Replace the parts in `< >`:

```bash
scp invokeboard-export-<date>.json <you>@<server>:/opt/invokeboard/import/
```

If it complains that the folder doesn't exist, create it on the server first with
`mkdir -p /opt/invokeboard/import`, then run the `scp` again.

---

## Step 5: Start the database and load the data

Back on the server:

```bash
# 1. Start the database
docker compose -f docker-compose.prod.yml up -d mysql

# 2. Wait until the STATUS column says "(healthy)". Re-run this every few seconds.
docker compose -f docker-compose.prod.yml ps mysql

# 3. Build the app (takes a few minutes the first time)
docker compose -f docker-compose.prod.yml build jira

# 4. Load the data. Replace <date> with the real file name.
docker compose -f docker-compose.prod.yml run --rm -v "$PWD/import:/import" jira \
  npx tsx packages/mcp-jira/scripts/storage-import.ts /import/invokeboard-export-<date>.json
```

✅ The last command should end with two lines like these, where both numbers are the same:

```
[storage-import] imported 19
[storage-import] verified 19/19
```

Then delete the data file from the server. You don't need it there anymore:

```bash
shred -u import/*.json
```

---

## Step 6: Start everything

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Check that it's running:

```bash
docker compose -f docker-compose.prod.yml ps
```

✅ `mysql`, `jira` and `github` show **(healthy)**. `web` and `cloudflared` show **Up**.

```bash
curl -s http://127.0.0.1:8080/jira/api/health
```

✅ You get a response containing `"ok":true`.

---

## Step 7: Go live

1. Open the dashboard's public address (the project owner knows it) and sign in.
2. Check that the existing data is there: leaves, team members, the last retro.
3. **Tell the project owner it's live**, so they can switch off the old copy of the app. While both
   are running, visitors are randomly sent to one or the other.

🎉 Done.

---

## Step 8: Turn on nightly backups

```bash
sudo mkdir -p /backups/invokeboard && sudo chown $USER /backups/invokeboard
scripts/backup-mysql.sh
```

✅ You see `[backup-mysql] wrote /backups/invokeboard/invokeboard-mysql-….sql.gz`.

To run it every night at 2 AM, open `crontab -e` and add this line:

```
0 2 * * * cd /opt/invokeboard && scripts/backup-mysql.sh >> /var/log/invokeboard-backup.log 2>&1
```

The script keeps the 14 newest backups. Copy them somewhere off the server now and then, but
**never together with the `.env` file**.

---

## Everyday commands

Run all of these from `/opt/invokeboard`. To save typing, create a shortcut first:

```bash
alias ib='docker compose -f docker-compose.prod.yml'
```

| I want to… | Command |
|---|---|
| See if everything is running | `ib ps` |
| See recent logs | `ib logs --tail 100 jira` |
| Restart the app | `ib restart` |
| Install an update | `git pull && ib up -d --build` |
| Stop everything | `ib down` |
| Restore a backup | `scripts/restore-mysql.sh /backups/invokeboard/<file>.sql.gz` |

> ⚠️ **Never run `ib down -v`.** The `-v` deletes the database and all data.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `set MYSQL_PASSWORD in .env` (or a similar message) | A setting is empty in `.env`. Fill it in (Step 3). |
| Import says `refusing to import … already holds N doc(s)` | The data is already loaded. Skip to Step 6. |
| Import says `verified` with two **different** numbers | Stop and send the project owner the full output. |
| `jira` keeps restarting | Run `ib logs --tail 50 jira`. A `Missing required environment variables` line names what's missing in `.env`. |
| Everyone's Jira/GitHub connection is broken after go-live | `TOKEN_ENC_KEY` doesn't match the old one. Fix it in `.env`, then run `ib up -d jira`. |
| Dashboard isn't reachable from the internet | Check `ib logs cloudflared` and confirm `CF_TUNNEL_TOKEN` is correct. |

Still stuck? Send the project owner the output of `ib ps` and `ib logs --tail 100`. **Do not send
the `.env` file.**
