# Lumin — Setup Guide

This guide walks through every environment variable and external service Lumin needs, from zero to a running bot with a live dashboard.

---

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **npm** (bundled with Node)
- A server or free Render/Railway account for hosting

---

## 1. Clone & Install

```bash
git clone https://github.com/your-repo/lumin.git
cd lumin
npm install
```

Create a `.env` file in the project root. All variables below go in here.

---

## 2. Discord Bot Token

**Variable:** `DISCORD_BOT_TOKEN`

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.
2. Give it a name (e.g. "Lumin"), then go to the **Bot** tab on the left.
3. Click **Reset Token** and copy the token that appears — this is your `DISCORD_BOT_TOKEN`. Store it immediately; you can't view it again.
4. On the same page, scroll down and enable these **Privileged Gateway Intents**:
   - **Server Members Intent**
   - **Message Content Intent**
5. Go to **OAuth2 → URL Generator**. Under Scopes check `bot` and `applications.commands`. Under Bot Permissions check at minimum:
   - Send Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Add Reactions
   - Use External Emojis
   - Manage Messages *(for cleanup)*
6. Copy the generated URL and open it to invite the bot to your server.

```env
DISCORD_BOT_TOKEN=your_token_here
```

> Slash commands are registered automatically on startup — no separate deploy script needed.

---

## 3. Google Gemini API Keys

**Variables:** `GOOGLE_API_KEY1`, `GOOGLE_API_KEY2`, … *(add as many as you want)*

Lumin supports unlimited API keys for automatic rotation when rate limits are hit.

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Click **Create API key**, select a Google Cloud project (or create one), and copy the key.
3. Repeat for as many keys as you want. Each key goes in a numbered variable.

```env
GOOGLE_API_KEY1=AIza...
GOOGLE_API_KEY2=AIza...   # optional; add more for better rate-limit tolerance
```

> A single key on the free tier works fine for small servers. Multiple keys are recommended for larger deployments or if you use Gemma models (which have daily caps per key).

---

## 4. MongoDB Atlas

**Variable:** `MONGODB_URI`

Lumin uses MongoDB for all persistent storage — conversation history, memory entries, settings, reminders, birthdays, and usage tracking.

### Create a free cluster

1. Go to [cloud.mongodb.com](https://cloud.mongodb.com) and sign in or create an account.
2. Click **Create** → choose the **Free** (M0) tier → pick a region close to your server → click **Create Cluster**.

### Create a database user

1. In the sidebar go to **Database Access** → **Add New Database User**.
2. Choose **Password** authentication, set a username and a strong password.
3. Under **Built-in Role** select **Read and write to any database**.
4. Click **Add User**.

### Allow network access

1. Go to **Network Access** → **Add IP Address**.
2. Click **Allow Access From Anywhere** (`0.0.0.0/0`) for a hosted deployment, or add your specific IP for local dev.
3. Click **Confirm**.

### Get the connection string

1. In the sidebar go to **Database** → click **Connect** on your cluster → **Drivers**.
2. Copy the connection string. It looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/
   ```
3. Replace `<username>` and `<password>` with the credentials from the step above.
4. Append the database name: `lumin` (Lumin will create collections automatically).

```env
MONGODB_URI=mongodb+srv://youruser:yourpassword@cluster0.xxxxx.mongodb.net/lumin
```

### Create the Vector Search index (for RAG memory)

1. In Atlas, open your cluster → **Collections** → find (or create) the `memoryEntries` collection.
2. Go to the **Search Indexes** tab → click **Create Search Index**.
3. Choose **JSON Editor**, select the `lumin` database and `memoryEntries` collection, name the index `vector_index`, and paste:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "embedding": {
        "type": "knnVector",
        "dimensions": 3072,
        "similarity": "cosine"
      },
      "metadata.historyId": {
        "type": "string"
      }
    }
  }
}
```

4. Click **Create Search Index**. It will take a minute to build.

> Without this index, Lumin automatically falls back to keyword search. The bot still works — semantic RAG just won't be available until the index exists.

---

## 5. Google OAuth (Dashboard login)

**Variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

The admin dashboard uses Google OAuth so only you can log in.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and open (or create) a project.
2. In the sidebar go to **APIs & Services → OAuth consent screen**.
   - Choose **External**, click **Create**.
   - Fill in App name, user support email, and developer contact email. The rest can be left blank for now.
   - Click **Save and Continue** through the remaining steps. You don't need to add scopes beyond the defaults.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name it anything (e.g. "LuminDash").
   - Under **Authorized redirect URIs**, add:
     ```
     https://your-deployment-url.com/dashboard/auth/google/callback
     ```
     For local development also add:
     ```
     http://localhost:3000/dashboard/auth/google/callback
     ```
4. Click **Create**. Copy the **Client ID** and **Client Secret**.

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret
```

### Dashboard allowed email

**Variable:** `DASHBOARD_ALLOWED_EMAIL`

This is the Google account email address that is permitted to log in to the dashboard. Any OAuth login from a different account will be rejected with "auth denied".

Set it to the exact email address of the Google account you used in the OAuth consent screen above.

```env
DASHBOARD_ALLOWED_EMAIL=you@gmail.com
```

> If this variable is not set, `dashboard/server.js` will log a warning on startup and **all** OAuth logins will be denied — the dashboard will be inaccessible until you add it.

---

## 6. reCAPTCHA v3 (Dashboard bot protection)

**Variables:** `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`

reCAPTCHA v3 runs silently on the dashboard login page to block automated requests.

1. Go to [google.com/recaptcha/admin/create](https://www.google.com/recaptcha/admin/create).
2. Label: anything (e.g. "LuminDash").
3. reCAPTCHA type: **Score based (v3)**.
4. Domains: add your deployment domain (e.g. `your-deployment.onrender.com`) and `localhost` for development.
5. Click **Submit**. You'll get a **Site Key** and a **Secret Key**.

```env
RECAPTCHA_SITE_KEY=6Lc_your_site_key
RECAPTCHA_SECRET_KEY=6Lc_your_secret_key
```

> If neither variable is set, reCAPTCHA verification is skipped and all dashboard login attempts are allowed through. Only omit these in fully private/local deployments.

---

## 7. Session Secret (Dashboard sessions)

**Variable:** `SESSION_SECRET`

Used to sign the dashboard session cookie. It should be a long random string — at least 64 characters.

Generate one in your terminal:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

```env
SESSION_SECRET=your_64_character_random_string_here
```

---

## 8. Redis (Optional — L3 cache)

**Variable:** `REDIS_URL`

Redis adds a third cache layer for embeddings and memory lookups, reducing Gemini API calls for frequently-accessed memories. Lumin falls back gracefully if this variable is absent.

### Upstash (recommended free option)

1. Go to [upstash.com](https://upstash.com) and create a free account.
2. Create a new **Redis** database → pick a region close to your bot's server → click **Create**.
3. On the database page, copy the **REST URL** — or for a standard Redis connection, go to **Details** and copy the `redis://...` connection string.

```env
REDIS_URL=redis://default:your_password@your-endpoint.upstash.io:6379
```

---

## 9. Optional variables

```env
# Persist structured logs to a file in addition to stdout
LOG_FILE=/var/log/lumin.log

# HTTP port for the Express server (dashboard + API)
# Defaults to 3000 if not set
PORT=3000

# Set to production to suppress development-only logs
NODE_ENV=production
```

---

## 10. Final `.env` file

```env
# ── Discord ───────────────────────────────────────────────────────────────────
DISCORD_BOT_TOKEN=

# ── Google Gemini ─────────────────────────────────────────────────────────────
GOOGLE_API_KEY1=
GOOGLE_API_KEY2=    # optional — add as many as you need

# ── MongoDB ───────────────────────────────────────────────────────────────────
MONGODB_URI=

# ── Dashboard — Google OAuth ──────────────────────────────────────────────────
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DASHBOARD_ALLOWED_EMAIL=    # the Google account email allowed to log in to the dashboard

# ── Dashboard — reCAPTCHA v3 ──────────────────────────────────────────────────
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=

# ── Dashboard — Session ───────────────────────────────────────────────────────
SESSION_SECRET=

# ── Optional ──────────────────────────────────────────────────────────────────
REDIS_URL=
LOG_FILE=
PORT=3000
NODE_ENV=production
GIPHY_API_KEY=   # GIF search — free key at https://developers.giphy.com (create app → API → copy key)
```

---

## 11. Start the bot

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

On the first run Lumin will:
1. Connect to MongoDB and create collections if they don't exist.
2. Register all slash commands with Discord automatically.
3. Start the Express server (dashboard available at `http://localhost:3000/dashboard`).
4. Begin background schedulers (reminders, birthdays, daily quotes, chat revival).

---

## 12. Deploying to Render

1. Push your repo to GitHub (make sure `.env` is in `.gitignore`).
2. Go to [render.com](https://render.com) → **New → Web Service** → connect your repo.
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Go to **Environment** and add all variables from the `.env` above.
5. Click **Deploy**.

For the Google OAuth redirect URI to work on Render, make sure you added your Render URL (`https://your-app.onrender.com/dashboard/auth/google/callback`) to the **Authorized redirect URIs** list in the Google Cloud Console (step 3 of the OAuth section above).

> Render's free tier spins down after 15 minutes of inactivity. Upgrade to a paid plan if you need always-on reminder and birthday delivery.

---

## Troubleshooting

**Bot doesn't respond to messages**
- Check that **Message Content Intent** is enabled in the Discord Developer Portal.
- Make sure the bot has **Read Message History** and **Send Messages** permissions in the channel.

**Slash commands don't appear**
- Commands are registered automatically on startup. Wait a few minutes after the first deploy for Discord to propagate them globally. If they still don't appear, check the startup logs for registration errors.

**Dashboard shows "auth denied"**
- `DASHBOARD_ALLOWED_EMAIL` in your `.env` must match the Google account you're signing in with exactly. Check for typos or trailing spaces, then redeploy.

**Vector search returns no results**
- Make sure the `vector_index` search index exists on the `memoryEntries` collection in Atlas and its status is **Active** (not Building).

**Rate limit errors**
- Add more `GOOGLE_API_KEY` entries to your `.env`. The `ApiKeyManager` will rotate between them automatically.

**Redis connection errors on startup**
- If you don't have Redis, simply don't set `REDIS_URL`. Lumin will log a warning and continue without it.
