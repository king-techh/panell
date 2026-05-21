# Toxic Tech Hosting Bot — Render Deployment

Telegram bot for selling game servers via Pterodactyl panel with dual M-Pesa payment methods.

## Quick Deploy to Render

### 1. Push to GitHub
```bash
cd toxic-tech-render
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/toxic-tech-bot.git
git push -u origin main
```

### 2. Create Render Web Service
1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Set:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Plan**: Free (or paid for always-on)

### 3. Set Environment Variables
In Render Dashboard → **Environment**, add these:

| Key | Value |
|-----|-------|
| `BOT_TOKEN` | Your Telegram bot token from @BotFather |
| `PTERO_API_KEY` | `ptla_XZgsTcVcUpgQaTO0AP8vtmS4UZ1oJkrldEbUITr5ZEq` |
| `PTERO_PANEL_URL` | `http://toxic-hosting.duckdns.org` |
| `SWIFTWALLET_API_KEY` | Your SwiftWallet API key |
| `XDIGITEX_API_KEY` | Your Xdigitex API key |
| `WEBHOOK_BASE_URL` | `https://your-app-name.onrender.com` |

The rest have defaults already set in `render.yaml`.

### 4. Deploy!
Click **Manual Deploy** → **Deploy latest commit**.

## Important Notes

- **PORT**: Render assigns `PORT` automatically. The bot detects this and uses it for the webhook server. Do NOT set `WEBHOOK_PORT` on Render.
- **WEBHOOK_BASE_URL**: Must be your full Render URL (e.g. `https://toxic-tech-bot.onrender.com`). This is needed for payment callbacks.
- **Data Persistence**: Render's free tier has ephemeral filesystem. The JSON database resets on redeploy. For production, upgrade to a paid plan with persistent disk or use an external database.
- **Free Tier Sleep**: Render free tier sleeps after 15 minutes of inactivity. The bot will stop processing until a request wakes it. Use a cron service (like cron-job.org) to ping your `/health` endpoint every 5 minutes to keep it awake.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/help` | Help message |
| `/servers` | Your servers & credentials |
| `/timeleft` | Trial time remaining |
| `/pricing` | View all plans |
| `/setup` | Admin: Auto-discover panel |
| `/stats` | Admin: Bot statistics |

## Architecture

```
index.js              → Main bot (Telegraf)
config.js             → Configuration + plans
database.js           → JSON file database
pterodactyl.js        → Pterodactyl API client
payment.js            → SwiftWallet M-Pesa + webhook server
xdigitex-payment.js   → Xdigitex Pay (Pan-Africa)
```

## Payment Methods

1. **SwiftWallet** — M-Pesa Kenya (Safaricom only), STK Push
2. **Xdigitex Pay** — M-Pesa + Airtel + 14 African countries, STK Push via `mobile` gateway
