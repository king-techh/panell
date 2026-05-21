require('dotenv').config();

module.exports = {
  // Telegram
  BOT_TOKEN: process.env.BOT_TOKEN,

  // Pterodactyl
  PTERO: {
    url: process.env.PTERO_PANEL_URL,
    apiKey: process.env.PTERO_API_KEY,
    // Correct IDs for panel: Nest 5 = "Mnare", Egg 15 = "node.js generic", Node 1 = "Yobi Mnare"
    nestId: parseInt(process.env.PTERO_NEST_ID) || 5,
    eggId: parseInt(process.env.PTERO_EGG_ID) || 15,
    nodeId: parseInt(process.env.PTERO_NODE_ID) || 1,
    dockerImage: process.env.PTERO_DOCKER_IMAGE || 'ghcr.io/ptero-eggs/yolks:nodejs_25',
    startupCmd: process.env.PTERO_STARTUP_CMD || 'if [[ "${MAIN_FILE}" == "*.js" ]]; then /usr/local/bin/node "/home/container/${MAIN_FILE}" ${NODE_ARGS}; else /usr/local/bin/ts-node --esm "/home/container/${MAIN_FILE}" ${NODE_ARGS}; fi',
  },

  // SwiftWallet (Payment Method 1 - M-Pesa Kenya)
  SWIFTWALLET: {
    apiKey: process.env.SWIFTWALLET_API_KEY,
    baseUrl: (process.env.SWIFTWALLET_BASE_URL || 'https://swiftwallet.co.ke').replace(/\/$/, ''),
  },

  // Xdigitex Pay (Payment Method 2 - Safaricom + Airtel + Pan-Africa)
  XDIGITEX: {
    apiKey: process.env.XDIGITEX_API_KEY || '',
    baseUrl: (process.env.XDIGITEX_BASE_URL || 'https://pay.xdigitex.space/api').replace(/\/$/, ''),
  },

  // Webhook Configuration (for payment callbacks)
  // Render assigns PORT dynamically — WEBHOOK_PORT can override but defaults to PORT
  WEBHOOK: {
    baseURL: (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
    port: parseInt(process.env.WEBHOOK_PORT) || parseInt(process.env.PORT) || 4000,
  },

  // Telegram Channel & Group (for join verification on bot start)
  CHANNEL: {
    link: process.env.CHANNEL_LINK || 'https://t.me/toxictechke',
    username: process.env.CHANNEL_USERNAME || '@toxictechke',
  },
  GROUP: {
    link: process.env.GROUP_LINK || 'https://t.me/+-YNHIfjLvLc4YzFk',
    // Group chat ID: 3733152624 -> Telegram supergroup format: -1003733152624
    chatId: process.env.GROUP_CHAT_ID || '-1003733152624',
  },
  WHATSAPP: {
    link: process.env.WHATSAPP_LINK || 'https://chat.whatsapp.com/HSPAImRNjQ0AkB7GG17BjZ?mode=gi_t',
  },

  // Admin
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'mnare00',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'jayjay#',

  // Email
  EMAIL_DOMAIN: process.env.EMAIL_DOMAIN || 'toxictech.com',

  // Server naming
  SERVER_PREFIX: process.env.SERVER_PREFIX || 'TOXIC TECH - ',

  // Trial
  TRIAL: {
    durationHours: parseInt(process.env.TRIAL_DURATION_HOURS) || 12,
    memory: parseInt(process.env.TRIAL_MEMORY) || 300,
    disk: parseInt(process.env.TRIAL_DISK) || 1000,
    cpu: parseInt(process.env.TRIAL_CPU) || 50,
  },

  // Payment
  PAYMENT: {
    pollInterval: parseInt(process.env.PAYMENT_POLL_INTERVAL) || 5000,
    pollTimeout: parseInt(process.env.PAYMENT_POLL_TIMEOUT) || 180000,
  },

  // Currency
  CURRENCY: process.env.BOT_CURRENCY || 'KES',

  // ─── PRICING PLANS ────────────────────────────────────────
  PLANS: {
    // Admin Panel plans
    admin: [
      {
        id: 'admin_monthly',
        name: 'Monthly Admin Panel',
        duration: '1 Month',
        price: 300,
        emoji: '📅',
        rootAdmin: true,
        durationDays: 30,
      },
      {
        id: 'admin_3months',
        name: '3 Months Admin Panel',
        duration: '3 Months',
        price: 530,
        emoji: '📅',
        rootAdmin: true,
        durationDays: 90,
      },
      {
        id: 'admin_6months',
        name: '6 Months Admin Panel',
        duration: '6 Months',
        price: 1490,
        emoji: '📅',
        rootAdmin: true,
        durationDays: 180,
      },
    ],

    // Server plans
    server: [
      {
        id: 'server_1gb',
        name: 'Starter Server',
        memory: 1024,
        disk: 2048,
        cpu: 0,
        price: 60,
        emoji: '1️⃣',
        durationDays: 30,
      },
      {
        id: 'server_5gb',
        name: 'Pro Server',
        memory: 5120,
        disk: 10240,
        cpu: 0,
        price: 80,
        emoji: '2️⃣',
        durationDays: 30,
      },
      {
        id: 'server_10gb',
        name: 'Elite Server',
        memory: 10240,
        disk: 0,
        cpu: 0,
        price: 101,
        emoji: '3️⃣',
        durationDays: 30,
      },
      {
        id: 'server_unlimited',
        name: 'God Tier Server',
        memory: 0,
        disk: 0,
        cpu: 0,
        price: 130,
        emoji: '👑',
        durationDays: 30,
      },
    ],
  },

  // Helper to find a plan by ID
  findPlan(planId) {
    const allPlans = [...this.PLANS.admin, ...this.PLANS.server];
    return allPlans.find((p) => p.id === planId);
  },

  // Helper to format resource display
  formatResource(value, unit = 'MB') {
    if (value === 0) return 'Unlimited';
    if (unit === 'MB' && value >= 1024) {
      return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB`;
    }
    return `${value} ${unit}`;
  },

  formatCpu(value) {
    if (value === 0) return 'Unlimited';
    return `${value}%`;
  },
};
