# Discord → Publer Bot

Right-click any message in Discord → **Apps** to:

- **Forward to Publer** — Create an idea in Publer (choose channels manually)
- **Publish to Twitter** — Edit text, then publish immediately to Twitter
- **Publish to all** — Edit text, then publish immediately to all connected accounts
- **Schedule to all** — Edit text, set date/time (e.g. "tomorrow 9am"), schedule to all channels (supports natural language; set `PUBLER_SCHEDULE_TIMEZONE` for your timezone, e.g. CET)

## Local setup

1. Copy `.env.example` to `.env` and fill in all values.
2. Run `node index.js`.

See `.env.example` for required variables.

## Deploy to Render

1. **Push to GitHub** (ensure `.env` is in `.gitignore` – never commit secrets).

2. Go to [render.com](https://render.com) → **Dashboard** → **New** → **Background Worker**.

3. **Connect your repo** and select the `discord-publer-bot` repository.

4. **Configure:**
   - **Name:** `discord-publer-bot` (or any name)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (if available)

5. **Environment Variables** → Add these (same as `.env`):
   - `DISCORD_TOKEN`
   - `GUILD_ID`
   - `PUBLER_API_KEY`
   - Optional: `PUBLER_WORKSPACE_NAME`, `PUBLER_EXCLUDE_PROVIDERS`, `PUBLER_IDEA_PRIVATE`, `PUBLER_SCHEDULE_TIMEZONE`

6. Click **Create Background Worker**. Render will build and run the bot.

7. Check the **Logs** tab to confirm `Logged in as YourBot#1234` and `Registered 4 command(s)`.
