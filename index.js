const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const config = require('./config');
const db = require('./database');
const ptero = require('./pterodactyl');
const payment = require('./payment');
const { paymentEvents } = require('./payment');
const xdigitexPayment = require('./xdigitex-payment');

// ─── Bot Initialization ──────────────────────────────────
const bot = new Telegraf(config.BOT_TOKEN);

// ─── Admin Users Set (Telegram IDs) ──────────────────────
const adminUsers = new Set();

// ─── State Management ────────────────────────────────────
const userStates = new Map();

function setState(userId, state) {
  userStates.set(String(userId), state);
}

function getState(userId) {
  return userStates.get(String(userId)) || null;
}

function clearState(userId) {
  userStates.delete(String(userId));
}

// ─── Utility Functions ───────────────────────────────────
function generateRandomString(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generatePassword(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateUsername(telegramUsername) {
  const base = (telegramUsername || 'user').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 12);
  const suffix = generateRandomString(4);
  return `${base}_${suffix}`;
}

function generateEmail() {
  // Format: toxic(7randomchars)@toxictech.com
  // Example: toxicA3k9x2m@toxictech.com
  const randomChars = generateRandomString(7);
  return `toxic${randomChars}@${config.EMAIL_DOMAIN}`;
}

function generateOrderId() {
  return `TXC-${Date.now()}-${generateRandomString(4).toUpperCase()}`;
}

function formatExpiry(date) {
  return new Date(date).toLocaleDateString('en-KE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Format Time Remaining (countdown) ────────────────────
// Returns human-readable countdown like "5h 32m 15s" or "Expired"

function formatTimeRemaining(expiresAt) {
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diff = expiry - now;

  if (diff <= 0) {
    return 'Expired';
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// ─── Progress Bar for Trial Countdown ───────────────────
// Generates a visual progress bar showing remaining trial time
// Full bar = 12 hours, each block = 1 hour

function generateProgressBar(hoursLeft, totalHours) {
  const total = Math.max(totalHours, 1);
  const left = Math.max(Math.min(hoursLeft, total), 0);
  const filled = Math.round((left / total) * 10);
  const empty = 10 - filled;

  const bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);
  const percent = Math.round((left / total) * 100);

  return `${bar} ${percent}%`;
}

function isAdmin(userId) {
  return adminUsers.has(String(userId));
}

// ─── Channel/Group Membership Check ──────────────────────

async function checkMembership(telegramUserId) {
  try {
    // Check if user is a member of the channel
    const channelUsername = config.CHANNEL.username.replace('@', '');
    const channelMember = await bot.telegram.getChatMember(`@${channelUsername}`, telegramUserId);
    const inChannel = ['member', 'administrator', 'creator'].includes(channelMember.status);

    // Check if user is a member of the group
    let inGroup = false;
    try {
      const groupMember = await bot.telegram.getChatMember(config.GROUP.chatId, telegramUserId);
      inGroup = ['member', 'administrator', 'creator'].includes(groupMember.status);
    } catch (err) {
      console.warn(`[Membership] Could not check group membership: ${err.message}`);
      // If we can't check, let them through
      inGroup = true;
    }

    return { inChannel, inGroup, allJoined: inChannel && inGroup };
  } catch (err) {
    console.warn(`[Membership] Could not check channel membership: ${err.message}`);
    // If we can't check (e.g. bot not admin), let them through
    return { inChannel: true, inGroup: true, allJoined: true };
  }
}

// ─── Premium Styled Messages ─────────────────────────────

const STYLES = {
  divider: '═══════════════════════════',
  header: (title) =>
    `⚡️ ═══════════════════════════\n   🔥 ${title} 🔥\n═══════════════════════════ ⚡️\n\n`,
  footer: `\n\n💎 <i>TOXIC TECH — Power in Your Hands</i>`,
};

function getJoinChannelText(user) {
  const name = user.first_name || user.username || 'Player';
  return (
    STYLES.header('TOXIC TECH HOSTING') +
    `👋 Hey <b>${escapeHtml(name)}</b>, welcome!\n\n` +
    `⚠️ <b>Before you can use the bot, you must join our Channel and Group!</b>\n\n` +
    `📢 <b>Telegram Channel:</b> <a href="${config.CHANNEL.link}">TOXIC TECH Channel</a>\n` +
    `👥 <b>Telegram Group:</b> <a href="${config.GROUP.link}">TOXIC TECH Group</a>\n` +
    `💬 <b>WhatsApp Group:</b> <a href="${config.WHATSAPP.link}">TOXIC TECH WhatsApp</a>\n\n` +
    `👇 <b>Join the Channel & Group, then tap "✅ Verify"</b>\n` +
    `💡 <i>WhatsApp is optional — only Channel & Group are verified.</i>` +
    STYLES.footer
  );
}

function getJoinChannelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.url('📢 Join Channel', config.CHANNEL.link),
      Markup.button.url('👥 Join Group', config.GROUP.link),
    ],
    [
      Markup.button.url('💬 Join WhatsApp', config.WHATSAPP.link),
    ],
    [Markup.button.callback('✅ Verify Membership', 'verify_membership')],
  ]);
}

function getWelcomeText(user) {
  const name = user.first_name || user.username || 'Player';
  const trialStatus = db.isTrialUsed(user.id) ? '✅ Used' : '🆓 Available';
  const adminBadge = isAdmin(user.id) ? '🛡️ ADMIN' : '👤 User';
  return (
    STYLES.header('TOXIC TECH HOSTING') +
    `👋 Hey <b>${escapeHtml(name)}</b>, welcome to the future of game hosting!\n` +
    `🔑 Role: <b>${adminBadge}</b>\n\n` +
    `🚀 <b>Lightning Fast Servers</b> — Zero lag gameplay\n` +
    `🛡️ <b>DDoS Protected</b> — Your server stays online\n` +
    `💎 <b>Premium Hardware</b> — Enterprise-grade performance\n` +
    `🌍 <b>24/7 Uptime</b> — Always online, always ready\n\n` +
    `🆓 <b>Free Trial:</b> ${trialStatus}\n\n` +
    `👇 <b>Choose your path below</b>` +
    STYLES.footer
  );
}

function getPricingText() {
  return (
    STYLES.header('PRICING PLANS') +
    `🆓 <b>FREE TRIAL</b> — 12 Hours\n` +
    `   ├ RAM: 300 MB\n` +
    `   ├ Disk: 1 GB\n` +
    `   ├ CPU: 50%\n` +
    `   └ Price: <b>FREE</b>\n\n` +
    STYLES.divider + '\n\n' +
    `🛡️ <b>ADMIN PANEL PLANS</b>\n\n` +
    `   📅 Monthly — <b>KES 300</b>\n` +
    `   📅 3 Months — <b>KES 530</b> (Save KES 370!)\n` +
    `   📅 6 Months — <b>KES 1,490</b> (Save KES 310!)\n\n` +
    STYLES.divider + '\n\n' +
    `💎 <b>SERVER PLANS</b> (Monthly)\n\n` +
    `   1️⃣ 1GB RAM | 2GB Disk | ∞ CPU — <b>KES 60</b>\n` +
    `   2️⃣ 5GB RAM | 10GB Disk | ∞ CPU — <b>KES 80</b>\n` +
    `   3️⃣ 10GB RAM | ∞ Disk | ∞ CPU — <b>KES 101</b>\n` +
    `   👑 ∞ RAM | ∞ Disk | ∞ CPU — <b>KES 130</b>\n\n` +
    `💡 <i>All servers include DDoS protection & 24/7 uptime!</i>` +
    STYLES.footer
  );
}

function getFreeTrialConfirmText(user) {
  const alreadyUsed = db.isTrialUsed(user.id);
  if (alreadyUsed) {
    return (
      STYLES.header('FREE TRIAL') +
      `😔 <b>You've already used your free trial!</b>\n\n` +
      `But don't worry — upgrade to a premium plan\n` +
      `and get even more power! 💎\n\n` +
      `👇 Check out our server plans below` +
      STYLES.footer
    );
  }
  return (
    STYLES.header('FREE TRIAL') +
    `🎁 <b>12-Hour Free Trial Server!</b>\n\n` +
    `Here's what you get:\n` +
    `   ├ 🧠 RAM: <b>300 MB</b>\n` +
    `   ├ 💾 Disk: <b>1 GB</b>\n` +
    `   ├ ⚡ CPU: <b>50%</b>\n` +
    `   ├ ⏰ Duration: <b>12 Hours</b>\n` +
    `   └ 💰 Price: <b>FREE!</b>\n\n` +
    `⚠️ <i>Trial is available once per user only.</i>\n` +
    `⚠️ <i>When trial expires (12 hrs), your server and account will be automatically deleted.</i>\n\n` +
    `👇 <b>Tap "✅ Start Free Trial" to begin!</b>\n` +
    `🔑 <i>Email, username & password will be auto-generated for you.</i>` +
    STYLES.footer
  );
}

function getServerPlansText() {
  const plans = config.PLANS.server;
  return (
    STYLES.header('PREMIUM SERVERS') +
    `💎 <b>Choose your server plan</b>\n\n` +
    plans
      .map(
        (p) =>
          `${p.emoji} <b>${p.name}</b>\n` +
          `   ├ 🧠 RAM: <b>${config.formatResource(p.memory)}</b>\n` +
          `   ├ 💾 Disk: <b>${config.formatResource(p.disk)}</b>\n` +
          `   ├ ⚡ CPU: <b>${config.formatCpu(p.cpu)}</b>\n` +
          `   └ 💰 <b>KES ${p.price}/month</b>\n`
      )
      .join('\n') +
    `\n💡 <i>Tap a plan below to purchase</i>` +
    STYLES.footer
  );
}

function getAdminPlansText() {
  const plans = config.PLANS.admin;
  return (
    STYLES.header('ADMIN PANEL') +
    `🛡️ <b>Get Full Admin Access</b>\n\n` +
    `Admin privileges include:\n` +
    `   ├ 🔧 Manage all servers\n` +
    `   ├ 👥 Manage users\n` +
    `   ├ 📊 View all resources\n` +
    `   └ ⚙️ Full panel control\n\n` +
    plans
      .map(
        (p) =>
          `${p.emoji} <b>${p.name}</b>\n` +
          `   ├ Duration: <b>${p.duration}</b>\n` +
          `   └ 💰 <b>KES ${p.price}</b>\n`
      )
      .join('\n') +
    `\n\n💡 <i>Tap a plan below to purchase</i>` +
    STYLES.footer
  );
}

// ─── Payment Method Selection Text ───────────────────────

function getPaymentMethodText(plan, orderId) {
  return (
    STYLES.header('SELECT PAYMENT METHOD') +
    `💳 <b>Order Summary</b>\n\n` +
    `   📦 Plan: <b>${plan.name}</b>\n` +
    `   💰 Amount: <b>KES ${plan.price}</b>\n` +
    `   🆔 Order: <code>${orderId}</code>\n\n` +
    STYLES.divider + '\n\n' +
    `👇 <b>Choose your payment method:</b>\n\n` +
    `1️⃣ <b>SwiftWallet (M-Pesa)</b>\n` +
    `   🇰🇪 Kenyan M-Pesa — Safaricom only\n` +
    `   📱 STK Push to your phone\n\n` +
    `2️⃣ <b>Xdigitex Pay</b>\n` +
    `   🇰🇪 M-Pesa (Safaricom + Airtel)\n` +
    `   🇹🇿 Airtel Tanzania & more\n` +
    `   🌍 Pan-Africa mobile money (14 countries)\n` +
    `   📱 STK Push to your phone\n\n` +
    `💡 <i>Select a method below</i>` +
    STYLES.footer
  );
}

function getPaymentPhoneText(plan, orderId, method) {
  const methodLabel = method === 'swiftwallet' ? 'SwiftWallet (M-Pesa)' : 'Xdigitex Pay';
  const phoneHint = method === 'swiftwallet'
    ? `Format: <code>0712345678</code> or <code>254712345678</code>\n\n🇰🇪 <i>Only Kenyan Safaricom numbers supported.</i>`
    : `Format: <code>0712345678</code> (Kenya) or <code>0621234567</code> (Tanzania)\n` +
      `Or international: <code>+254712345678</code> / <code>+255621234567</code>\n\n` +
      `🇰🇪 <i>M-Pesa (Safaricom) & Airtel Kenya</i>\n` +
      `🇹🇿 <i>Airtel Tanzania & Vodacom</i>\n` +
      `🌍 <i>Pan-Africa: 14 countries, 20+ networks</i>`;

  return (
    STYLES.header('PAYMENT — ' + methodLabel.toUpperCase()) +
    `💳 <b>Order Summary</b>\n\n` +
    `   📦 Plan: <b>${plan.name}</b>\n` +
    `   💰 Amount: <b>KES ${plan.price}</b>\n` +
    `   🆔 Order: <code>${orderId}</code>\n` +
    `   💳 Method: <b>${methodLabel}</b>\n\n` +
    STYLES.divider + '\n\n' +
    `📱 <b>Enter your phone number</b>\n\n` +
    phoneHint + '\n\n' +
    `🌍 <i>Not supported? DM </i><a href="https://t.me/${config.ADMIN_USERNAME}">@${config.ADMIN_USERNAME}</a>` +
    STYLES.footer
  );
}

function getPaymentSuccessText(plan, serverInfo, userCredentials) {
  return (
    STYLES.header('PAYMENT SUCCESSFUL! 🎉') +
    `✅ <b>Payment confirmed!</b>\n\n` +
    `📦 <b>Plan:</b> ${plan.name}\n` +
    `💰 <b>Amount:</b> KES ${plan.price}\n\n` +
    STYLES.divider + '\n\n' +
    `🔐 <b>Your Panel Credentials</b>\n\n` +
    `🌐 <b>Panel:</b> <code>${config.PTERO.url}</code>\n` +
    `👤 <b>Username:</b> <code>${userCredentials.username}</code>\n` +
    `🔑 <b>Password:</b> <code>${userCredentials.password}</code>\n` +
    `📧 <b>Email:</b> <code>${userCredentials.email}</code>\n\n` +
    (serverInfo
      ? `🎮 <b>Server:</b> <code>${serverInfo.name}</code>\n` +
        `   ├ 🆔 Server ID: ${serverInfo.id}\n` +
        `   ├ 🧠 RAM: ${config.formatResource(
          serverInfo.limits ? serverInfo.limits.memory : plan.memory
        )}\n` +
        `   ├ 💾 Disk: ${config.formatResource(
          serverInfo.limits ? serverInfo.limits.disk : plan.disk
        )}\n` +
        `   └ ⚡ CPU: ${config.formatCpu(
          serverInfo.limits ? serverInfo.limits.cpu : plan.cpu
        )}\n\n`
      : `🛡️ <b>Admin Access:</b> Enabled\n\n`) +
    `⚠️ <i>Save these credentials! You won't see them again.</i>\n` +
    `💡 <i>Login at the panel URL above to manage your server.</i>` +
    STYLES.footer
  );
}

function getTrialSuccessText(serverInfo, userCredentials) {
  const dbUser = db.getUser(serverInfo._telegramId);
  const expiresAt = dbUser ? dbUser.trialExpiresAt : 'N/A';
  const timeLeft = expiresAt !== 'N/A' ? formatTimeRemaining(expiresAt) : '12 hours';
  return (
    STYLES.header('TRIAL SERVER CREATED! 🎉') +
    `✅ <b>Your free trial is now active!</b>\n\n` +
    `⏰ <b>Time Left: ${timeLeft}</b>\n` +
    `📅 <b>Expires: ${expiresAt !== 'N/A' ? formatExpiry(expiresAt) : '12 hours'}</b>\n\n` +
    STYLES.divider + '\n\n' +
    `🔐 <b>Your Panel Credentials</b>\n\n` +
    `🌐 <b>Panel:</b> <code>${config.PTERO.url}</code>\n` +
    `👤 <b>Username:</b> <code>${userCredentials.username}</code>\n` +
    `🔑 <b>Password:</b> <code>${userCredentials.password}</code>\n` +
    `📧 <b>Email:</b> <code>${userCredentials.email}</code>\n\n` +
    `🎮 <b>Server:</b> <code>${serverInfo.name}</code>\n` +
    `   ├ 🆔 Server ID: ${serverInfo.id}\n` +
    `   ├ 🧠 RAM: 300 MB\n` +
    `   ├ 💾 Disk: 1 GB\n` +
    `   └ ⚡ CPU: 50%\n\n` +
    `⚠️ <i>Save these credentials! You won't see them again.</i>\n` +
    `💡 <i>Login at the panel URL above to start your server.</i>\n\n` +
    `⏰ <i>Use /servers to check your remaining time anytime!</i>\n` +
    `⚠️ <i>When your 12-hour trial expires, your server and account will be automatically deleted.</i>\n` +
    `💎 <i>Want more? Upgrade to a premium plan anytime!</i>` +
    STYLES.footer
  );
}

function getMyServersText(user) {
  const dbUser = db.getUser(user.id);
  if (!dbUser || !dbUser.pteroUserId) {
    return (
      STYLES.header('MY SERVERS') +
      `📭 <b>No servers found!</b>\n\n` +
      `You haven't created any servers yet.\n` +
      `Start with a free trial or grab a premium plan! 💎\n\n` +
      `👇 Choose an option below` +
      STYLES.footer
    );
  }

  const subs = db.getActiveSubscriptions(user.id);
  const trialActive =
    dbUser.trialUsed && dbUser.trialExpiresAt && new Date(dbUser.trialExpiresAt) > new Date();

  let text =
    STYLES.header('MY SERVERS') +
    `🔐 <b>Panel Credentials</b>\n\n` +
    `🌐 <b>Panel:</b> <code>${config.PTERO.url}</code>\n` +
    `👤 <b>Username:</b> <code>${dbUser.pteroUsername || 'N/A'}</code>\n` +
    `🔑 <b>Password:</b> <code>${dbUser.pteroPassword || 'N/A'}</code>\n` +
    `📧 <b>Email:</b> <code>${dbUser.pteroEmail || 'N/A'}</code>\n\n` +
    STYLES.divider + '\n\n';

  if (trialActive) {
    const timeLeft = formatTimeRemaining(dbUser.trialExpiresAt);
    text +=
      `🆓 <b>Free Trial Server</b>\n` +
      `   ├ ⏰ Time Left: <b>${timeLeft}</b>\n` +
      `   ├ 📅 Expires: ${formatExpiry(dbUser.trialExpiresAt)}\n` +
      `   ├ 🆔 Server ID: ${dbUser.trialServerId || 'N/A'}\n` +
      `   ├ 🧠 RAM: 300 MB | 💾 Disk: 1 GB | ⚡ CPU: 50%\n` +
      `   └ 🎮 Server: ${config.SERVER_PREFIX}${user.username || 'user'}\n\n` +
      `⚠️ <i>Your server & account will be deleted when trial expires.</i>\n` +
      `💎 <i>Upgrade to a premium plan to keep your server!</i>\n\n`;
  } else if (dbUser.trialUsed && dbUser.trialExpiresAt) {
    text += `🆓 <b>Free Trial</b> — Expired ❌\n\n`;
  }

  if (subs.length > 0) {
    text += `💎 <b>Active Subscriptions</b>\n\n`;
    subs.forEach((sub, i) => {
      const plan = config.findPlan(sub.planId);
      text +=
        `#${i + 1} ${plan ? plan.emoji : '📦'} <b>${plan ? plan.name : sub.planId}</b>\n` +
        `   ├ 🎮 Server: ${sub.serverName || 'N/A'}\n` +
        `   ├ ⏰ Expires: ${formatExpiry(sub.expiresAt)}\n` +
        `   └ 🆔 Server ID: ${sub.serverId || 'N/A'}\n\n`;
    });
  }

  if (!trialActive && subs.length === 0) {
    text += `📭 <b>No active subscriptions</b>\n\n`;
    text += `Grab a plan and get started! 💪\n`;
  }

  text += STYLES.footer;
  return text;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Formspree Email Notification ────────────────────────

const FORMSPREE_URL = 'https://formspree.io/f/xpqnwkwa';

async function sendTrialNotification({ telegramUser, serverName, serverId, username, expiresAt }) {
  try {
    const expiryFormatted = formatExpiry(expiresAt);
    const now = new Date().toLocaleString('en-KE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    await axios.post(FORMSPREE_URL, {
      email: 'admin@toxictech.com',
      _subject: `🆓 New Free Trial Claimed — ${telegramUser.username || telegramUser.first_name || 'Unknown'}`,
      message: `
╔══════════════════════════════════════════╗
║     TOXIC TECH — FREE TRIAL ALERT       ║
╚══════════════════════════════════════════╝

🔥 A new user has claimed a FREE TRIAL server!

┌──────────────────────────────────────────┐
│  USER INFORMATION                        │
├──────────────────────────────────────────┤
│  👤 Telegram: @${telegramUser.username || 'N/A'}
│  🆔 User ID: ${telegramUser.id}
│  📛 Name: ${telegramUser.first_name || 'N/A'} ${telegramUser.last_name || ''}
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  SERVER DETAILS                          │
├──────────────────────────────────────────┤
│  🎮 Server Name: ${serverName}
│  🆔 Server ID: ${serverId}
│  👤 Panel Username: ${username}
│  🧠 RAM: 300 MB | 💾 Disk: 1 GB | ⚡ CPU: 50%
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  EXPIRY INFORMATION                      │
├──────────────────────────────────────────┤
│  ⏰ Trial Expires: ${expiryFormatted}
│  ⏱️ Duration: 12 Hours
│  ⚠️ Auto-deletion: Server + User will be
│     automatically removed on expiry
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  TIMESTAMP                               │
├──────────────────────────────────────────┤
│  📅 Claimed at: ${now}
└──────────────────────────────────────────┘

💎 TOXIC TECH — Power in Your Hands
      `.trim(),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    console.log(`[Formspree] Trial notification sent for @${telegramUser.username || telegramUser.id}`);
  } catch (err) {
    console.warn(`[Formspree] Failed to send notification: ${err.message}`);
  }
}

// ─── Keyboard Layouts ────────────────────────────────────

function getMainMenuKeyboard(userId) {
  const buttons = [
    [
      Markup.button.callback('🆓 Free Trial', 'free_trial'),
      Markup.button.callback('💎 Servers', 'server_plans'),
    ],
    [
      Markup.button.callback('🛡️ Admin Panel', 'admin_plans'),
      Markup.button.callback('📋 My Servers', 'my_servers'),
    ],
    [
      Markup.button.callback('💰 Pricing', 'pricing'),
      Markup.button.callback('📞 Support', 'support'),
    ],
  ];

  return Markup.inlineKeyboard(buttons);
}

function getFreeTrialKeyboard(trialUsed) {
  const buttons = [];
  if (!trialUsed) {
    buttons.push([Markup.button.callback('✅ Start Free Trial', 'confirm_trial')]);
  } else {
    buttons.push([Markup.button.callback('💎 View Server Plans', 'server_plans')]);
  }
  buttons.push([Markup.button.callback('🔙 Back to Menu', 'main_menu')]);
  return Markup.inlineKeyboard(buttons);
}

function getServerPlansKeyboard() {
  const plans = config.PLANS.server;
  return Markup.inlineKeyboard([
    ...plans.map((p) => [
      Markup.button.callback(`${p.emoji} ${p.name} — KES ${p.price}`, `buy_${p.id}`),
    ]),
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

function getAdminPlansKeyboard() {
  const plans = config.PLANS.admin;
  return Markup.inlineKeyboard([
    ...plans.map((p) => [
      Markup.button.callback(
        `${p.emoji} ${p.duration} — KES ${p.price}`,
        `buy_${p.id}`
      ),
    ]),
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

function getBackKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Menu', 'main_menu')]]);
}

function getPaymentMethodKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('1️⃣ SwiftWallet (M-Pesa Kenya)', `pay_swiftwallet_${orderId}`)],
    [Markup.button.callback('2️⃣ Xdigitex Pay (M-Pesa + Africa)', `pay_xdigitex_${orderId}`)],
    [Markup.button.callback('❌ Cancel', 'cancel_payment')],
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

function getPaymentKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Payment', 'cancel_payment')],
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

function getSupportKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.url(
        '💬 DM Admin',
        `https://t.me/${config.ADMIN_USERNAME}`
      ),
    ],
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

function getMyServersKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'refresh_servers')],
    [Markup.button.callback('🔙 Back to Menu', 'main_menu')],
  ]);
}

// ─── Command Handlers ────────────────────────────────────

bot.start(async (ctx) => {
  try {
    const user = ctx.from;

    if (db.isAdmin(user.id)) {
      adminUsers.add(String(user.id));
    }

    db.upsertUser(user.id, {
      username: user.username || '',
      firstName: user.first_name || '',
    });

    const prevMsgId = db.getMainMessageId(user.id);
    if (prevMsgId) {
      try {
        await ctx.deleteMessage(prevMsgId).catch(() => {});
      } catch (e) {}
    }

    // ─── CHECK MEMBERSHIP FIRST ──────────────────────────
    const membership = await checkMembership(user.id);
    if (!membership.allJoined) {
      const text = getJoinChannelText(user);
      const keyboard = getJoinChannelKeyboard();

      const msg = await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
        disable_web_page_preview: true,
      });

      db.setMainMessageId(user.id, msg.message_id);
      clearState(user.id);
      return;
    }

    // ─── Already joined — show main menu ──────────────────
    const text = getWelcomeText(user);
    const keyboard = getMainMenuKeyboard(user.id);

    const msg = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });

    db.setMainMessageId(user.id, msg.message_id);
    clearState(user.id);
  } catch (err) {
    console.error('Start error:', err);
  }
});

bot.help(async (ctx) => {
  const text =
    STYLES.header('HELP') +
    `📝 <b>Commands</b>\n\n` +
    `/start — 🏠 Main menu\n` +
    `/help — 📝 This help message\n` +
    `/servers — 📋 Your servers & credentials\n` +
    `/timeleft — ⏰ Trial time remaining\n` +
    `/pricing — 💰 View all plans\n\n` +
    `💡 <i>Use the inline buttons to navigate!</i>` +
    STYLES.footer;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

bot.command('servers', async (ctx) => {
  try {
    const user = ctx.from;
    const text = getMyServersText(user);
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Servers command error:', err);
  }
});

bot.command('timeleft', async (ctx) => {
  try {
    const user = ctx.from;
    const dbUser = db.getUser(user.id);

    if (!dbUser || !dbUser.trialUsed || !dbUser.trialExpiresAt) {
      await ctx.reply(
        STYLES.header('TIME LEFT') +
        `📭 <b>No active trial found!</b>\n\n` +
        `You don't have an active free trial.\n` +
        `Use /start to get started!` +
        STYLES.footer,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      return;
    }

    const now = new Date();
    const expiry = new Date(dbUser.trialExpiresAt);
    const diff = expiry - now;

    if (diff <= 0) {
      await ctx.reply(
        STYLES.header('TIME LEFT') +
        `⏰ <b>Your free trial has expired!</b>\n\n` +
        `Your server and account have been deleted.\n\n` +
        `💎 <i>Upgrade to a premium plan to get back online!</i>\n` +
        `👇 Use /start to browse plans` +
        STYLES.footer,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      return;
    }

    const timeLeft = formatTimeRemaining(dbUser.trialExpiresAt);
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const progressBar = generateProgressBar(hours, 12);

    await ctx.reply(
      STYLES.header('TRIAL COUNTDOWN') +
      `⏰ <b>Your Free Trial Status</b>\n\n` +
      `${progressBar}\n\n` +
      `⏳ <b>Time Left: ${timeLeft}</b>\n\n` +
      `   Hours: <b>${hours}</b>\n` +
      `   Minutes: <b>${minutes}</b>\n` +
      `   Seconds: <b>${seconds}</b>\n\n` +
      `📅 Expires: ${formatExpiry(dbUser.trialExpiresAt)}\n` +
      `🆔 Server ID: ${dbUser.trialServerId || 'N/A'}\n\n` +
      STYLES.divider + '\n\n' +
      `🔐 <b>Your Credentials</b>\n\n` +
      `🌐 Panel: <code>${config.PTERO.url}</code>\n` +
      `👤 Username: <code>${dbUser.pteroUsername || 'N/A'}</code>\n` +
      `🔑 Password: <code>${dbUser.pteroPassword || 'N/A'}</code>\n` +
      `📧 Email: <code>${dbUser.pteroEmail || 'N/A'}</code>\n\n` +
      `⚠️ <i>When trial expires, your server & account are auto-deleted.</i>\n` +
      `💎 <i>Want more time? Upgrade to premium!</i>` +
      STYLES.footer,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Timeleft command error:', err);
  }
});

bot.command('pricing', async (ctx) => {
  try {
    const text = getPricingText();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Pricing command error:', err);
  }
});

bot.command('setup', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Admin only command.');
      return;
    }

    ptero.clearEggCache();
    const disc = await ptero.autoDiscover();

    const text =
      `🔧 <b>Panel Setup Info</b>\n\n` +
      `🌐 Panel: <code>${config.PTERO.url}</code>\n` +
      `🔑 API Key: <code>${config.PTERO.apiKey.substring(0, 10)}...</code>\n\n` +
      `📦 <b>Auto-Discovered:</b>\n` +
      `   Node ID: <b>${disc.nodeId || 'N/A'}</b>\n` +
      `   Nest ID: <b>${disc.nestId || 'N/A'}</b>\n` +
      `   Egg ID: <b>${disc.eggId || 'N/A'}</b>\n` +
      `   Egg Name: <b>${disc.eggDetails ? disc.eggDetails.name : 'N/A'}</b>\n` +
      `   Docker: <code>${disc.eggDetails ? disc.eggDetails.docker_image : 'N/A'}</code>\n\n` +
      `⚙️ <b>Config Defaults:</b>\n` +
      `   Nest: ${config.PTERO.nestId} | Egg: ${config.PTERO.eggId} | Node: ${config.PTERO.nodeId}\n` +
      `   Docker: <code>${config.PTERO.dockerImage}</code>`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Setup command error:', err);
  }
});

bot.command('stats', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Admin only command.');
      return;
    }

    const stats = db.getStats();
    const text =
      STYLES.header('BOT STATISTICS') +
      `📊 <b>TOXIC TECH Bot Stats</b>\n\n` +
      `👥 Total Users: <b>${stats.totalUsers}</b>\n` +
      `🆓 Trial Users: <b>${stats.trialUsers}</b>\n` +
      `💎 Active Subs: <b>${stats.activeSubscriptions}</b>\n` +
      `📦 Total Orders: <b>${stats.totalOrders}</b>\n` +
      `🛡️ Admin Users: <b>${stats.adminUsers}</b>\n` +
      `⏳ SwiftWallet Pending: <b>${payment.pendingPayments.size}</b>\n` +
      `⏳ Xdigitex Pending: <b>${xdigitexPayment.pendingPayments.size}</b>` +
      STYLES.footer;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Stats command error:', err);
  }
});

// ─── Callback Query Handlers ─────────────────────────────

bot.action('verify_membership', async (ctx) => {
  try {
    await ctx.answerCbQuery('🔍 Checking membership...');
    const user = ctx.from;

    const membership = await checkMembership(user.id);

    if (membership.allJoined) {
      // User has joined both — show main menu
      const text = getWelcomeText(user);
      const keyboard = getMainMenuKeyboard(user.id);
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
        disable_web_page_preview: true,
      });
    } else {
      // Still not joined — show what's missing
      let missing = [];
      if (!membership.inChannel) missing.push('📢 Channel');
      if (!membership.inGroup) missing.push('👥 Group');

      await ctx.answerCbQuery(`❌ You haven't joined: ${missing.join(' & ')}`, { show_alert: true });

      const text =
        STYLES.header('VERIFICATION FAILED') +
        `❌ <b>You haven't joined yet!</b>\n\n` +
        `Missing:\n` +
        (!membership.inChannel ? `   ❌ <b>Channel</b> — <a href="${config.CHANNEL.link}">Join here</a>\n` : `   ✅ <b>Channel</b> — Joined!\n`) +
        (!membership.inGroup ? `   ❌ <b>Group</b> — <a href="${config.GROUP.link}">Join here</a>\n` : `   ✅ <b>Group</b> — Joined!\n`) +
        `\n💬 <b>WhatsApp:</b> <a href="${config.WHATSAPP.link}">Join here</a> (optional)\n\n` +
        `👇 <b>Join Channel & Group, then tap "✅ Verify" again</b>` +
        STYLES.footer;

      const keyboard = getJoinChannelKeyboard();
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.error('Verify membership error:', err);
  }
});

bot.action('main_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = ctx.from;

    if (db.isAdmin(user.id)) {
      adminUsers.add(String(user.id));
    }

    db.upsertUser(user.id, { username: user.username || '', firstName: user.first_name || '' });
    const text = getWelcomeText(user);
    const keyboard = getMainMenuKeyboard(user.id);
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Main menu error:', err);
  }
});

bot.action('pricing', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const text = getPricingText();
    const keyboard = getBackKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Pricing error:', err);
  }
});

bot.action('support', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const text =
      STYLES.header('SUPPORT') +
      `📞 <b>Need Help?</b>\n\n` +
      `💬 DM our admin for assistance:\n` +
      `👨‍💻 <a href="https://t.me/${config.ADMIN_USERNAME}">@${config.ADMIN_USERNAME}</a>\n\n` +
      `🌍 <b>Not in Kenya?</b>\n` +
      `If you need alternative payment methods,\n` +
      `reach out to the admin directly!\n\n` +
      `⏰ <i>Response time: Usually within a few hours</i>` +
      STYLES.footer;
    const keyboard = getSupportKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Support error:', err);
  }
});

// ─── Free Trial Flow ─────────────────────────────────────
// Free trial AUTO-GENERATES email/username/password
// No user input needed for trial — instant creation

bot.action('free_trial', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = ctx.from;
    const trialUsed = db.isTrialUsed(user.id);
    const text = getFreeTrialConfirmText(user);
    const keyboard = getFreeTrialKeyboard(trialUsed);
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Free trial error:', err);
  }
});

bot.action('confirm_trial', async (ctx) => {
  try {
    await ctx.answerCbQuery('🎮 Creating your trial server...');

    const user = ctx.from;

    if (db.isTrialUsed(user.id)) {
      await ctx.editMessageText(getFreeTrialConfirmText(user), {
        parse_mode: 'HTML',
        reply_markup: getFreeTrialKeyboard(true).reply_markup,
        disable_web_page_preview: true,
      });
      return;
    }

    const mainMsgId = db.getMainMessageId(user.id);

    // Show "creating" message
    if (mainMsgId) {
      await ctx.telegram.editMessageText(
        user.id, mainMsgId, undefined,
        STYLES.header('CREATING SERVER') +
          `⏳ <b>Setting up your trial server...</b>\n\n` +
          `🔄 Creating account...\n` +
          `🔄 Allocating resources...\n` +
          `🔄 Installing server...\n\n` +
          `⏱️ <i>This may take a moment...</i>` +
          STYLES.footer,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    }

    // Auto-generate credentials for free trial
    const username = generateUsername(user.username);
    const password = generatePassword();
    const email = generateEmail();
    const serverName = `${config.SERVER_PREFIX}${user.username || 'player'}`;

    // Create Pterodactyl user
    let pteroUser;
    try {
      pteroUser = await ptero.createUser(username, email, password, user.first_name || 'Trial', 'User', false);
    } catch (err) {
      if (mainMsgId) {
        await ctx.telegram.editMessageText(
          user.id, mainMsgId, undefined,
          STYLES.header('ERROR') +
            `❌ <b>Failed to create account</b>\n\n` +
            `Error: ${escapeHtml(err.message)}\n\n` +
            `⚠️ <i>Please try again or contact support.</i>`,
          { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
        );
      }
      return;
    }

    let serverInfo;
    try {
      serverInfo = await ptero.createServer({
        name: serverName,
        userId: pteroUser.id,
        memory: config.TRIAL.memory,
        disk: config.TRIAL.disk,
        cpu: config.TRIAL.cpu,
      });
    } catch (err) {
      if (mainMsgId) {
        await ctx.telegram.editMessageText(
          user.id, mainMsgId, undefined,
          STYLES.header('ERROR') +
            `❌ <b>Failed to create server</b>\n\n` +
            `Error: ${escapeHtml(err.message)}\n\n` +
            `Your account was created but server allocation failed.\n` +
            `Please contact support.`,
          { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
        );
      }
      db.upsertUser(user.id, {
        pteroUserId: pteroUser.id,
        pteroUsername: username,
        pteroPassword: password,
        pteroEmail: email,
      });
      return;
    }

    // 12-hour trial expiry
    const expiresAt = new Date();
    expiresAt.setTime(expiresAt.getTime() + config.TRIAL.durationHours * 60 * 60 * 1000);

    db.useTrial(user.id, pteroUser.id, username, password, email, serverInfo.id, expiresAt.toISOString());

    db.addSubscription(user.id, {
      planId: 'free_trial',
      serverName: serverName,
      serverId: serverInfo.id,
      expiresAt: expiresAt.toISOString(),
      type: 'trial',
      active: true,
    });

    sendTrialNotification({
      telegramUser: user,
      serverName: serverName,
      serverId: serverInfo.id,
      username: username,
      expiresAt: expiresAt.toISOString(),
    });

    const successText = getTrialSuccessText(
      { id: serverInfo.id, name: serverName, _telegramId: user.id, limits: { memory: config.TRIAL.memory, disk: config.TRIAL.disk, cpu: config.TRIAL.cpu } },
      { username, password, email }
    );

    if (mainMsgId) {
      await ctx.telegram.editMessageText(
        user.id, mainMsgId, undefined,
        successText,
        { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
      );
    }
  } catch (err) {
    console.error('Confirm trial error:', err);
    try {
      await ctx.editMessageText(
        STYLES.header('ERROR') +
          `❌ <b>Something went wrong</b>\n\n` +
          `Error: ${escapeHtml(err.message)}\n\n` +
          `Please try again or contact support.`,
        { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
      );
    } catch (e) {}
  }
});

bot.action('server_plans', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const text = getServerPlansText();
    const keyboard = getServerPlansKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Server plans error:', err);
  }
});

bot.action('admin_plans', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const text = getAdminPlansText();
    const keyboard = getAdminPlansKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Admin plans error:', err);
  }
});

bot.action('my_servers', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = ctx.from;
    const text = getMyServersText(user);
    const keyboard = getMyServersKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('My servers error:', err);
  }
});

bot.action('refresh_servers', async (ctx) => {
  try {
    await ctx.answerCbQuery('🔄 Refreshed!');
    const user = ctx.from;
    const text = getMyServersText(user);
    const keyboard = getMyServersKeyboard();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Refresh servers error:', err);
  }
});

// ─── Purchase Flow ───────────────────────────────────────

bot.action(/^buy_(.+)$/, async (ctx) => {
  try {
    const planId = ctx.match[1];
    const plan = config.findPlan(planId);

    if (!plan) {
      await ctx.answerCbQuery('❌ Plan not found!');
      return;
    }

    await ctx.answerCbQuery();

    const orderId = generateOrderId();

    db.createOrder(orderId, {
      telegramId: String(ctx.from.id),
      planId: planId,
      amount: plan.price,
      planName: plan.name,
    });

    setState(ctx.from.id, {
      action: 'awaiting_payment_method',
      planId: planId,
      orderId: orderId,
    });

    // Show payment method selection
    const text = getPaymentMethodText(plan, orderId);
    const keyboard = getPaymentMethodKeyboard(orderId);

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Buy action error:', err);
  }
});

// ─── Payment Method Selection ────────────────────────────

bot.action(/^pay_swiftwallet_(.+)$/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery();

    const state = getState(ctx.from.id);
    if (!state || state.orderId !== orderId) {
      await ctx.answerCbQuery('❌ Session expired');
      return;
    }

    const plan = config.findPlan(state.planId);
    if (!plan) {
      await ctx.answerCbQuery('❌ Plan not found');
      return;
    }

    setState(ctx.from.id, {
      ...state,
      action: 'awaiting_phone',
      paymentMethod: 'swiftwallet',
      step: 'phone_input',
    });

    const text = getPaymentPhoneText(plan, orderId, 'swiftwallet');
    const keyboard = getPaymentKeyboard(orderId);

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('SwiftWallet method error:', err);
  }
});

bot.action(/^pay_xdigitex_(.+)$/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery();

    const state = getState(ctx.from.id);
    if (!state || state.orderId !== orderId) {
      await ctx.answerCbQuery('❌ Session expired');
      return;
    }

    const plan = config.findPlan(state.planId);
    if (!plan) {
      await ctx.answerCbQuery('❌ Plan not found');
      return;
    }

    setState(ctx.from.id, {
      ...state,
      action: 'awaiting_phone',
      paymentMethod: 'xdigitex',
      step: 'phone_input',
    });

    const text = getPaymentPhoneText(plan, orderId, 'xdigitex');
    const keyboard = getPaymentKeyboard(orderId);

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Xdigitex method error:', err);
  }
});

bot.action('cancel_payment', async (ctx) => {
  try {
    await ctx.answerCbQuery('❌ Payment cancelled');
    const state = getState(ctx.from.id);
    if (state && state.orderId) {
      db.updateOrder(state.orderId, { status: 'cancelled' });
      payment.cancelPayment(state.orderId);
      xdigitexPayment.cancelPayment(state.orderId);
    }
    clearState(ctx.from.id);
    const text = getWelcomeText(ctx.from);
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(ctx.from.id).reply_markup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Cancel payment error:', err);
  }
});

// ─── Text Message Handler ────────────────────────────────
// Handles: Paid plan credentials (email/username/password)
//          and Phone number input for payments

bot.on('text', async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state) return;

  try {
    const text = ctx.message.text.trim();
    const user = ctx.from;
    const mainMsgId = db.getMainMessageId(user.id);

    // ─── Paid Plan Credentials Collection ────────────────
    // After payment is confirmed, user enters email/username/password
    if (state.action === 'paid_credentials') {
      try { await ctx.deleteMessage(); } catch (e) {}

      if (state.step === 'email') {
        // Validate email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
          if (mainMsgId) {
            await ctx.telegram.editMessageText(
              user.id, mainMsgId, undefined,
              STYLES.header('INVALID EMAIL') +
                `❌ <b>Invalid email format!</b>\n\n` +
                `Please enter a valid email:\n` +
                `📧 Format: <code>yourname@example.com</code>` +
                STYLES.footer,
              { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
            );
          }
          return;
        }

        setState(user.id, { ...state, step: 'username', email: text });

        if (mainMsgId) {
          await ctx.telegram.editMessageText(
            user.id, mainMsgId, undefined,
            STYLES.header('CREDENTIALS — STEP 2/3') +
              `✅ Email: <code>${escapeHtml(text)}</code>\n\n` +
              STYLES.divider + '\n\n' +
              `👤 <b>Step 2/3: Enter your username</b>\n\n` +
              `Format: <code>letters_numbers_underscores</code>\n` +
              `⚠️ <i>Min 3 characters, no spaces or special chars</i>\n\n` +
              `💡 <i>Send your username as a message below</i>` +
              STYLES.footer,
            { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
          );
        }
        return;
      }

      if (state.step === 'username') {
        // Validate username
        const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
        if (!usernameRegex.test(text)) {
          if (mainMsgId) {
            await ctx.telegram.editMessageText(
              user.id, mainMsgId, undefined,
              STYLES.header('INVALID USERNAME') +
                `❌ <b>Invalid username!</b>\n\n` +
                `Rules:\n` +
                `   ├ 3-20 characters\n` +
                `   ├ Letters, numbers, underscores only\n` +
                `   └ No spaces or special characters\n\n` +
                `📧 Email saved: <code>${escapeHtml(state.email)}</code>\n\n` +
                `💡 <i>Send a valid username</i>` +
                STYLES.footer,
              { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
            );
          }
          return;
        }

        setState(user.id, { ...state, step: 'password', username: text });

        if (mainMsgId) {
          await ctx.telegram.editMessageText(
            user.id, mainMsgId, undefined,
            STYLES.header('CREDENTIALS — STEP 3/3') +
              `✅ Email: <code>${escapeHtml(state.email)}</code>\n` +
              `✅ Username: <code>${escapeHtml(text)}</code>\n\n` +
              STYLES.divider + '\n\n' +
              `🔑 <b>Step 3/3: Enter your password</b>\n\n` +
              `⚠️ <i>Min 6 characters — use a strong password!</i>\n\n` +
              `💡 <i>Send your password as a message below</i>` +
              STYLES.footer,
            { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
          );
        }
        return;
      }

      if (state.step === 'password') {
        // Validate password — minimum 6 characters
        if (text.length < 6) {
          if (mainMsgId) {
            await ctx.telegram.editMessageText(
              user.id, mainMsgId, undefined,
              STYLES.header('INVALID PASSWORD') +
                `❌ <b>Password too short!</b>\n\n` +
                `Minimum 6 characters required.\n\n` +
                `✅ Email: <code>${escapeHtml(state.email)}</code>\n` +
                `✅ Username: <code>${escapeHtml(state.username)}</code>\n\n` +
                `💡 <i>Send a longer password (min 6 characters)</i>` +
                STYLES.footer,
              { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
            );
          }
          return;
        }

        // All credentials collected — create the user and server!
        const email = state.email;
        const username = state.username;
        const password = text;
        const plan = config.findPlan(state.planId);
        const isAdminPlan = plan && plan.rootAdmin === true;

        clearState(user.id);

        // Show "creating" message
        if (mainMsgId) {
          await ctx.telegram.editMessageText(
            user.id, mainMsgId, undefined,
            STYLES.header('CREATING YOUR RESOURCES') +
              `⏳ <b>Setting up your ${isAdminPlan ? 'admin access' : 'server'}...</b>\n\n` +
              `🔄 Creating account...\n` +
              (isAdminPlan ? `🔄 Granting admin privileges...\n` : `🔄 Allocating resources...\n🔄 Installing server...\n`) +
              `\n⏱️ <i>This may take a moment...</i>` +
              STYLES.footer,
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
        }

        // Create Pterodactyl user
        let pteroUser;
        try {
          pteroUser = await ptero.createUser(
            username,
            email,
            password,
            state.telegramFirstName || 'User',
            'Panel',
            isAdminPlan
          );
        } catch (err) {
          console.error('[PaidCredentials] Failed to create user:', err.message);
          if (mainMsgId) {
            await ctx.telegram.editMessageText(
              user.id, mainMsgId, undefined,
              STYLES.header('ERROR') +
                `❌ <b>Failed to create account</b>\n\n` +
                `Error: ${escapeHtml(err.message)}\n\n` +
                `⚠️ <i>Username might already be taken. Try a different one.</i>`,
              { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
            );
          }
          return;
        }

        let serverInfo = null;

        // If it's a server plan, create the server
        if (!isAdminPlan) {
          const serverName = `${config.SERVER_PREFIX}${state.telegramUsername || 'player'}`;
          try {
            serverInfo = await ptero.createServer({
              name: serverName,
              userId: pteroUser.id,
              memory: plan.memory,
              disk: plan.disk,
              cpu: plan.cpu,
            });
          } catch (err) {
            console.error('[PaidCredentials] Server creation failed:', err.message);
            db.upsertUser(user.id, {
              pteroUserId: pteroUser.id,
              pteroUsername: username,
              pteroPassword: password,
              pteroEmail: email,
            });
            if (mainMsgId) {
              await ctx.telegram.editMessageText(
                user.id, mainMsgId, undefined,
                STYLES.header('PARTIAL SUCCESS') +
                  `⚠️ <b>Account created but server creation failed</b>\n\n` +
                  `Error: ${escapeHtml(err.message)}\n\n` +
                  STYLES.divider + '\n\n' +
                  `🔐 <b>Your Panel Credentials</b>\n\n` +
                  `🌐 Panel: <code>${config.PTERO.url}</code>\n` +
                  `👤 Username: <code>${username}</code>\n` +
                  `🔑 Password: <code>${password}</code>\n` +
                  `📧 Email: <code>${email}</code>\n\n` +
                  `⚠️ <i>Contact @${config.ADMIN_USERNAME} to fix your server.</i>` +
                  STYLES.footer,
                { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
              );
            }
            return;
          }
        }

        // ─── Save to database ────────────────────────────────
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + (plan.durationDays || 30));

        db.upsertUser(user.id, {
          pteroUserId: pteroUser.id,
          pteroUsername: username,
          pteroPassword: password,
          pteroEmail: email,
        });

        if (isAdminPlan) {
          db.addSubscription(user.id, {
            planId: state.planId,
            expiresAt: expiresAt.toISOString(),
            type: 'admin',
            active: true,
          });

          adminUsers.add(String(user.id));
          db.setAdmin(user.id, true);
        } else if (serverInfo) {
          db.addSubscription(user.id, {
            planId: state.planId,
            serverName: serverInfo.name,
            serverId: serverInfo.id,
            expiresAt: expiresAt.toISOString(),
            type: 'server',
            active: true,
          });
        }

        // ─── Show success message ────────────────────────────
        const successText = getPaymentSuccessText(
          plan,
          serverInfo ? {
            id: serverInfo.id,
            name: serverInfo.name,
            limits: serverInfo.limits || { memory: plan.memory, disk: plan.disk, cpu: plan.cpu },
          } : null,
          { username, password, email }
        );

        if (mainMsgId) {
          try {
            await ctx.telegram.editMessageText(
              user.id, mainMsgId, undefined,
              successText,
              {
                parse_mode: 'HTML',
                reply_markup: getBackKeyboard().reply_markup,
                disable_web_page_preview: true,
              }
            );
          } catch (e) {}
        }
        return;
      }
    }

    // ─── Phone Number Input for Payments ─────────────────
    if (state.action === 'awaiting_phone') {
      const phoneInput = text;
      const paymentMethod = state.paymentMethod || 'swiftwallet';

      let formattedPhone;
      if (paymentMethod === 'xdigitex') {
        try {
          formattedPhone = xdigitexPayment.formatPhone(phoneInput);
        } catch (err) {
          if (mainMsgId) {
            try {
              await ctx.telegram.editMessageText(
                user.id, mainMsgId, undefined,
                STYLES.header('INVALID PHONE') +
                  `❌ <b>Invalid phone number!</b>\n\n` +
                  `Please enter a valid phone number:\n` +
                  `📱 Kenya: <code>0712345678</code> or <code>+254712345678</code>\n` +
                  `📱 Tanzania: <code>0621234567</code> or <code>+255621234567</code>\n\n` +
                  `🌍 <i>Supports: Safaricom, Airtel Kenya, Airtel Tanzania & more</i>` +
                  STYLES.footer,
                {
                  parse_mode: 'HTML',
                  reply_markup: getPaymentKeyboard(state.orderId).reply_markup,
                  disable_web_page_preview: true,
                }
              );
            } catch (e) {}
          }
          try { await ctx.deleteMessage(); } catch (e) {}
          return;
        }
      } else {
        // SwiftWallet — Kenya only
        try {
          formattedPhone = payment._formatPhone(phoneInput);
        } catch (err) {
          if (mainMsgId) {
            try {
              await ctx.telegram.editMessageText(
                user.id, mainMsgId, undefined,
                STYLES.header('INVALID PHONE') +
                  `❌ <b>Invalid phone number!</b>\n\n` +
                  `Please enter a valid Kenyan phone number:\n` +
                  `📱 Format: <code>0712345678</code> or <code>254712345678</code>\n\n` +
                  `🇰🇪 <i>Only Kenyan Safaricom numbers supported for this method.</i>\n` +
                  `🌍 <i>Not in Kenya? Try Payment Method 2 (Xdigitex Pay)</i>` +
                  STYLES.footer,
                {
                  parse_mode: 'HTML',
                  reply_markup: getPaymentKeyboard(state.orderId).reply_markup,
                  disable_web_page_preview: true,
                }
              );
            } catch (e) {}
          }
          try { await ctx.deleteMessage(); } catch (e) {}
          return;
        }
      }

      try { await ctx.deleteMessage(); } catch (e) {}

      const plan = config.findPlan(state.planId);
      if (!plan) {
        clearState(ctx.from.id);
        return;
      }

      // Show "sending STK push" message
      if (mainMsgId) {
        const methodLabel = paymentMethod === 'swiftwallet' ? 'SwiftWallet' : 'Xdigitex Pay';
        await ctx.telegram.editMessageText(
          user.id, mainMsgId, undefined,
          STYLES.header('PROCESSING PAYMENT') +
            `⏳ <b>Sending STK Push via ${methodLabel}...</b>\n\n` +
            `📱 <b>Check your phone!</b>\n` +
            `Enter your PIN to complete payment.\n\n` +
            `📦 Plan: <b>${plan.name}</b>\n` +
            `💰 Amount: <b>KES ${plan.price}</b>\n` +
            `💳 Method: <b>${methodLabel}</b>\n\n` +
            `⏱️ <i>Waiting for confirmation...</i>` +
            STYLES.footer,
          {
            parse_mode: 'HTML',
            reply_markup: getPaymentKeyboard(state.orderId).reply_markup,
            disable_web_page_preview: true,
          }
        );
      }

      // ─── Initiate STK Push ─────────────────────────────
      let stkResult;
      if (paymentMethod === 'xdigitex') {
        stkResult = await xdigitexPayment.initiateSTKPush(
          formattedPhone,
          plan.price,
          state.orderId,
          user.id,
          state.planId,
          user.first_name || 'Customer'
        );
      } else {
        stkResult = await payment.initiateSTKPush(
          formattedPhone,
          plan.price,
          state.orderId,
          user.id,
          state.planId
        );
      }

      if (!stkResult.success) {
        if (mainMsgId) {
          await ctx.telegram.editMessageText(
            user.id, mainMsgId, undefined,
            STYLES.header('PAYMENT ERROR') +
              `❌ <b>Failed to initiate payment</b>\n\n` +
              `Error: ${escapeHtml(stkResult.message)}\n\n` +
              `💡 <i>Try a different payment method or contact support.</i>\n` +
              `🌍 <i>Need help? DM </i><a href="https://t.me/${config.ADMIN_USERNAME}">@${config.ADMIN_USERNAME}</a>` +
              STYLES.footer,
            {
              parse_mode: 'HTML',
              reply_markup: getPaymentKeyboard(state.orderId).reply_markup,
              disable_web_page_preview: true,
            }
          );
        }
        clearState(user.id);
        return;
      }

      // Update state
      setState(user.id, {
        ...state,
        action: 'awaiting_phone',
        step: 'awaiting_payment',
        paymentMethod: paymentMethod,
        transactionId: stkResult.transactionId,
        checkoutRequestId: stkResult.checkoutRequestId,
        phone: formattedPhone,
        telegramUsername: user.username || 'user',
        telegramFirstName: user.first_name || 'User',
      });

      // Update order
      db.updateOrder(state.orderId, {
        transactionId: stkResult.transactionId,
        checkoutRequestId: stkResult.checkoutRequestId,
        phone: formattedPhone,
        status: 'stk_sent',
        paymentMethod: paymentMethod,
      });

      // Show "waiting for PIN" message
      const methodLabel = paymentMethod === 'swiftwallet' ? 'SwiftWallet (M-Pesa)' : 'Xdigitex Pay';
      const timeoutHint = paymentMethod === 'swiftwallet'
        ? `⏱️ <i>Payment window: 3 minutes</i>`
        : `🔄 <i>Live check — no timeout! We'll wait until you pay or cancel.</i>`;
      if (mainMsgId) {
        await ctx.telegram.editMessageText(
          user.id, mainMsgId, undefined,
          STYLES.header('PROCESSING PAYMENT') +
            `⏳ <b>STK Push sent via ${methodLabel}!</b>\n\n` +
            `📱 <b>Check your phone: ${formattedPhone}</b>\n` +
            `Enter your PIN to complete payment.\n\n` +
            `📦 Plan: <b>${plan.name}</b>\n` +
            `💰 Amount: <b>KES ${plan.price}</b>\n` +
            `🆔 Order: <code>${state.orderId}</code>\n` +
            `💳 Method: <b>${methodLabel}</b>\n\n` +
            `✅ <i>Enter your PIN on your phone</i>\n` +
            `🔄 <i>Live payment check active — instant detection!</i>\n` +
            timeoutHint +
            STYLES.footer,
          {
            parse_mode: 'HTML',
            reply_markup: getPaymentKeyboard(state.orderId).reply_markup,
            disable_web_page_preview: true,
          }
        );
      }
    }
  } catch (err) {
    console.error('Text handler error:', err);
    clearState(ctx.from.id);
  }
});

// ─── Payment Event Handlers (from polling + webhook) ─────

paymentEvents.on('payment_success', async (data) => {
  console.log(`[Payment] SUCCESS for order ${data.orderId}, user ${data.telegramId}`);

  try {
    const state = getState(data.telegramId);
    if (!state || state.orderId !== data.orderId) {
      console.warn(`[Payment] No matching state for order ${data.orderId}`);
      return;
    }

    const user = { id: data.telegramId };
    const mainMsgId = db.getMainMessageId(data.telegramId);
    const plan = config.findPlan(data.planId);

    if (!plan) {
      console.error(`[Payment] Plan not found: ${data.planId}`);
      return;
    }

    // Update order
    db.updateOrder(data.orderId, { status: 'paid' });

    // ─── After payment confirmed, ask user for credentials ──────
    // Instead of auto-generating, we now collect email/username/password
    setState(data.telegramId, {
      action: 'paid_credentials',
      step: 'email',
      email: null,
      username: null,
      password: null,
      planId: data.planId,
      orderId: data.orderId,
      telegramUsername: state.telegramUsername || 'user',
      telegramFirstName: state.telegramFirstName || 'User',
    });

    if (mainMsgId) {
      try {
        await bot.telegram.editMessageText(
          data.telegramId,
          mainMsgId,
          undefined,
          STYLES.header('PAYMENT CONFIRMED! ✅') +
            `✅ <b>Payment confirmed!</b>\n\n` +
            `📦 Plan: <b>${plan.name}</b>\n` +
            `💰 Amount: <b>KES ${plan.price}</b>\n\n` +
            STYLES.divider + '\n\n' +
            `🔐 <b>Enter your panel credentials</b>\n\n` +
            `You'll use these to log into the Pterodactyl panel.\n\n` +
            `📧 <b>Step 1/3: Enter your email</b>\n\n` +
            `Format: <code>yourname@example.com</code>\n\n` +
            `💡 <i>Send your email address as a message below</i>` +
            STYLES.footer,
          {
            parse_mode: 'HTML',
            reply_markup: getBackKeyboard().reply_markup,
            disable_web_page_preview: true,
          }
        );
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Payment] Success handler error:', err);
    try {
      const mainMsgId = db.getMainMessageId(data.telegramId);
      if (mainMsgId) {
        await bot.telegram.editMessageText(
          data.telegramId,
          mainMsgId,
          undefined,
          STYLES.header('ERROR') +
            `❌ <b>Payment confirmed but setup failed</b>\n\n` +
            `Error: ${escapeHtml(err.message)}\n\n` +
            `Please contact @${config.ADMIN_USERNAME} for assistance.` +
            STYLES.footer,
          { parse_mode: 'HTML', reply_markup: getBackKeyboard().reply_markup, disable_web_page_preview: true }
        );
      }
    } catch (e) {}
    clearState(data.telegramId);
  }
});

paymentEvents.on('payment_failed', async (data) => {
  console.log(`[Payment] FAILED for order ${data.orderId}, user ${data.telegramId}`);

  try {
    const state = getState(data.telegramId);
    if (!state || state.orderId !== data.orderId) {
      console.warn(`[Payment] No matching state for failed order ${data.orderId}`);
      return;
    }

    const mainMsgId = db.getMainMessageId(data.telegramId);
    const resultDesc = data.message || 'Payment failed or cancelled';
    const isTimeout = data.resultCode === -1;
    const isCancelled = data.resultCode === '1032' || data.resultCode === 1032;

    db.updateOrder(data.orderId, { status: 'failed' });

    if (mainMsgId) {
      try {
        let failureMsg;
        if (isTimeout) {
          failureMsg = `⏱️ <b>Payment timed out</b>\n\n` +
            `The payment was not completed within 3 minutes.\n\n` +
            `💡 <i>Please try again if you still want to purchase.</i>\n`;
        } else if (isCancelled) {
          failureMsg = `❌ <b>Payment cancelled</b>\n\n` +
            `You cancelled the payment on your phone.\n\n` +
            `💡 <i>No worries! You can try again anytime.</i>\n`;
        } else {
          failureMsg = `❌ <b>Payment was not completed</b>\n\n` +
            `Reason: ${escapeHtml(resultDesc)}\n\n` +
            `💡 <i>If you cancelled, you can try again anytime.</i>\n`;
        }

        await bot.telegram.editMessageText(
          data.telegramId,
          mainMsgId,
          undefined,
          STYLES.header('PAYMENT FAILED') +
            failureMsg +
            STYLES.divider + '\n\n' +
            `🌍 <i>Need help? DM </i><a href="https://t.me/${config.ADMIN_USERNAME}">@${config.ADMIN_USERNAME}</a>` +
            STYLES.footer,
          {
            parse_mode: 'HTML',
            reply_markup: getBackKeyboard().reply_markup,
            disable_web_page_preview: true,
          }
        );
      } catch (e) {}
    }

    clearState(data.telegramId);
  } catch (err) {
    console.error('[Payment] Failed handler error:', err);
    clearState(data.telegramId);
  }
});

// ─── Auto-Expiry Cleanup: Delete User + Server ──────────
// Runs every 10 minutes — checks for expired trials (12 hrs)
// and deletes the Pterodactyl user + server + DB record

async function cleanupExpiredUsers() {
  const now = new Date();
  const users = db.getAllUsers();
  let deleted = 0;
  let errors = 0;

  for (const user of users) {
    try {
      let shouldDelete = false;

      // Check if trial has expired (12 hours)
      if (user.trialUsed && user.trialExpiresAt && new Date(user.trialExpiresAt) < now) {
        const hasActivePaidSubs = (user.subscriptions || []).some(
          s => s.active && s.type !== 'trial'
        );
        if (!hasActivePaidSubs) {
          shouldDelete = true;
        }
      }

      // Check if all subscriptions have expired
      if (!shouldDelete && user.subscriptions) {
        const hasActiveSubs = user.subscriptions.some(s => s.active);
        if (!hasActiveSubs && user.pteroUserId) {
          const hadServerSub = user.subscriptions.some(s => s.type === 'server' || s.type === 'trial');
          if (hadServerSub && !user.isAdmin) {
            shouldDelete = true;
          }
        }
      }

      if (!shouldDelete) continue;

      console.log(`[AutoCleanup] Removing expired user ${user.telegramId} (@${user.username})`);

      // ─── Send "Free trial over" message BEFORE deleting ──────
      try {
        const trialExpired = user.trialUsed && user.trialExpiresAt && new Date(user.trialExpiresAt) < now;
        if (trialExpired) {
          await bot.telegram.sendMessage(
            user.telegramId,
            STYLES.header('FREE TRIAL OVER') +
            `⏰ <b>Your 12-hour free trial has expired!</b>\n\n` +
            `Your server and account have been automatically deleted from the panel.\n\n` +
            STYLES.divider + '\n\n' +
            `💎 <b>Want to keep playing?</b>\n\n` +
            `Upgrade to a premium plan and get:\n` +
            `   ├ 🧠 More RAM & Disk\n` +
            `   ├ ⚡ Unlimited CPU\n` +
            `   ├ 🛡️ DDoS Protection\n` +
            `   └ ⏰ 24/7 Uptime\n\n` +
            `👇 <b>Tap the button below to get started!</b>\n\n` +
            `🌍 <i>Need help? DM </i><a href="https://t.me/${config.ADMIN_USERNAME}">@${config.ADMIN_USERNAME}</a>` +
            STYLES.footer,
            {
              parse_mode: 'HTML',
              reply_markup: getMainMenuKeyboard(user.id || user.telegramId).reply_markup,
              disable_web_page_preview: true,
            }
          );
          console.log(`[AutoCleanup] Sent "Free trial over" message to user ${user.telegramId}`);
        }
      } catch (msgErr) {
        // User might have blocked the bot — that's OK, continue with deletion
        console.warn(`[AutoCleanup] Could not send expiry message to ${user.telegramId}: ${msgErr.message}`);
      }

      if (user.pteroUserId) {
        try {
          const servers = await ptero.getUserServers(user.pteroUserId);
          for (const server of servers) {
            try {
              await ptero.deleteServer(server.id);
              console.log(`[AutoCleanup] Deleted server ${server.id} (${server.name})`);
            } catch (err) {
              console.warn(`[AutoCleanup] Failed to delete server ${server.id}: ${err.message}`);
            }
          }
        } catch (err) {
          console.warn(`[AutoCleanup] Failed to list servers for ptero user ${user.pteroUserId}: ${err.message}`);
        }

        try {
          await ptero.deleteUser(user.pteroUserId);
          console.log(`[AutoCleanup] Deleted ptero user ${user.pteroUserId} (${user.pteroUsername})`);
        } catch (err) {
          console.warn(`[AutoCleanup] Failed to delete ptero user ${user.pteroUserId}: ${err.message}`);
        }
      }

      db.deleteUser(user.telegramId);
      adminUsers.delete(String(user.telegramId));

      deleted++;
      console.log(`[AutoCleanup] Fully removed expired user ${user.telegramId} (@${user.username})`);
    } catch (err) {
      errors++;
      console.error(`[AutoCleanup] Error processing user ${user.telegramId}:`, err.message);
    }
  }

  return { deleted, errors };
}

// ─── Bot Startup ─────────────────────────────────────────

async function startBot() {
  try {
    // Clear egg cache on startup
    ptero.clearEggCache();

    // Auto-discover panel resources
    console.log('[Startup] Auto-discovering Pterodactyl panel resources...');
    try {
      const disc = await ptero.autoDiscover();
      console.log('[Startup] Auto-discovery complete!');
      console.log(`  Node: ${disc.nodeId}, Nest: ${disc.nestId}, Egg: ${disc.eggId}`);
    } catch (err) {
      console.warn(`[Startup] Auto-discovery failed (will use config defaults): ${err.message}`);
    }

    // Start webhook server for payment callbacks
    payment.startWebhookServer();

    // Restore admin users from DB
    const users = db.getAllUsers();
    for (const user of users) {
      if (user.isAdmin) {
        adminUsers.add(String(user.telegramId));
      }
    }

    // ─── Run expired user cleanup on startup ───────────
    console.log('[Startup] Checking for expired users...');
    const startupResult = await cleanupExpiredUsers();
    if (startupResult.deleted > 0) {
      console.log(`[Startup] Cleaned up ${startupResult.deleted} expired users`);
    }

    // ─── Auto-cleanup expired users every 1 minute ─────
    // Fast check so trial expiry and "Free trial over" messages
    // are sent close to real-time
    setInterval(async () => {
      try {
        const result = await cleanupExpiredUsers();
        if (result.deleted > 0) {
          console.log(`[AutoCleanup] Removed ${result.deleted} expired users (${result.errors} errors)`);
        }
      } catch (err) {
        console.error('[AutoCleanup] Error:', err.message);
      }
    }, 60 * 1000);

    // ─── Real-time countdown notifications for trial users ──
    // Checks every 5 minutes and sends countdown warnings
    // at key intervals: 6h, 3h, 1h, 30m, 10m, 5m, 1m remaining
    const sentWarnings = new Map(); // telegramId -> Set of warning levels sent

    setInterval(async () => {
      try {
        const users = db.getAllUsers();
        const now = new Date();

        for (const user of users) {
          if (!user.trialUsed || !user.trialExpiresAt) continue;

          const expiry = new Date(user.trialExpiresAt);
          const diff = expiry - now;

          // Skip if already expired (cleanup will handle it)
          if (diff <= 0) continue;

          const minutesLeft = Math.floor(diff / (1000 * 60));
          const hoursLeft = minutesLeft / 60;

          // Determine warning level
          let warningLevel = null;
          let warningMsg = null;

          if (hoursLeft <= 1/60 && minutesLeft <= 1) {
            // 1 minute left
            warningLevel = '1m';
            warningMsg = `🚨 <b>1 MINUTE LEFT!</b>\n\nYour free trial server is about to expire! Your server and account will be deleted in 1 minute.\n\n💎 <i>Upgrade NOW to keep your server!</i>`;
          } else if (minutesLeft <= 5 && minutesLeft > 1) {
            // 5 minutes left
            warningLevel = '5m';
            warningMsg = `🔴 <b>5 MINUTES LEFT!</b>\n\nYour free trial expires in 5 minutes! After that, your server and account will be automatically deleted.\n\n💎 <i>Upgrade now to keep your server!</i>`;
          } else if (minutesLeft <= 10 && minutesLeft > 5) {
            // 10 minutes left
            warningLevel = '10m';
            warningMsg = `🟠 <b>10 MINUTES LEFT!</b>\n\nYour free trial is almost over! Your server and account will be deleted soon.\n\n💎 <i>Don't lose your server — upgrade now!</i>`;
          } else if (minutesLeft <= 30 && minutesLeft > 10) {
            // 30 minutes left
            warningLevel = '30m';
            warningMsg = `🟡 <b>30 MINUTES LEFT!</b>\n\nYour free trial expires in 30 minutes. Time to upgrade if you want to keep your server!\n\n💎 <i>Upgrade to premium for uninterrupted service!</i>`;
          } else if (hoursLeft <= 1 && hoursLeft > 0.5) {
            // 1 hour left
            warningLevel = '1h';
            warningMsg = `⏰ <b>1 HOUR LEFT!</b>\n\nYour free trial expires in 1 hour. After that, your server and account will be deleted.\n\n💎 <i>Upgrade to keep your server running!</i>`;
          } else if (hoursLeft <= 3 && hoursLeft > 1) {
            // 3 hours left
            warningLevel = '3h';
            warningMsg = `⏰ <b>3 HOURS LEFT!</b>\n\nYour free trial expires in 3 hours.\n\n💎 <i>Consider upgrading to keep your server!</i>`;
          } else if (hoursLeft <= 6 && hoursLeft > 3) {
            // 6 hours left
            warningLevel = '6h';
            warningMsg = `⏰ <b>HALFWAY POINT!</b>\n\n6 hours remaining on your free trial (12h total).\n\n💎 <i>Upgrade anytime to keep your server permanently!</i>`;
          }

          if (warningLevel && warningMsg) {
            // Check if we already sent this warning level to this user
            if (!sentWarnings.has(user.telegramId)) {
              sentWarnings.set(user.telegramId, new Set());
            }
            const sent = sentWarnings.get(user.telegramId);
            if (!sent.has(warningLevel)) {
              sent.add(warningLevel);
              try {
                await bot.telegram.sendMessage(
                  user.telegramId,
                  STYLES.header('TRIAL COUNTDOWN') +
                  warningMsg + '\n\n' +
                  `⏳ <b>Time Left: ${formatTimeRemaining(user.trialExpiresAt)}</b>\n` +
                  `📅 <b>Expires: ${formatExpiry(user.trialExpiresAt)}</b>\n\n` +
                  `🔑 <i>Use /timeleft for real-time countdown</i>` +
                  STYLES.footer,
                  {
                    parse_mode: 'HTML',
                    reply_markup: getMainMenuKeyboard(user.telegramId).reply_markup,
                    disable_web_page_preview: true,
                  }
                );
                console.log(`[Countdown] Sent ${warningLevel} warning to user ${user.telegramId}`);
              } catch (msgErr) {
                console.warn(`[Countdown] Could not send ${warningLevel} warning to ${user.telegramId}: ${msgErr.message}`);
              }
            }
          }
        }

        // Clean up sentWarnings for users who no longer have active trials
        for (const [tid, _] of sentWarnings.entries()) {
          const u = db.getUser(tid);
          if (!u || !u.trialExpiresAt || new Date(u.trialExpiresAt) < now) {
            sentWarnings.delete(tid);
          }
        }
      } catch (err) {
        console.error('[Countdown] Error:', err.message);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes

    // Cleanup old pending payments every 10 minutes
    setInterval(() => {
      payment.cleanupPendingPayments();
      xdigitexPayment.cleanupPendingPayments();
    }, 10 * 60 * 1000);

    // Deactivate expired subscriptions every hour
    setInterval(() => {
      const cleaned = db.cleanupExpired();
      if (cleaned > 0) {
        console.log(`[Cleanup] Deactivated ${cleaned} expired subscriptions`);
      }
    }, 60 * 60 * 1000);

    // Launch bot
    await bot.launch();
    console.log('🔥 TOXIC TECH Bot started successfully!');
    console.log(`   Panel: ${config.PTERO.url}`);
    console.log(`   Webhook: ${config.WEBHOOK.baseURL}/webhook`);
    console.log(`   Users in DB: ${db.getAllUsers().length}`);
    console.log(`   Channel: ${config.CHANNEL.link}`);
    console.log(`   Group: ${config.GROUP.link}`);
    console.log(`   WhatsApp: ${config.WHATSAPP.link}`);
    console.log(`   Payment Methods: SwiftWallet + Xdigitex Pay`);
    console.log(`   Xdigitex Gateway: mobile (Pan-Africa, auto-detect)`);
    console.log(`   Trial Duration: ${config.TRIAL.durationHours} hours`);
    console.log(`   Auto-cleanup: Expired users + servers removed every 1 min`);
    console.log(`   Countdown warnings: 6h, 3h, 1h, 30m, 10m, 5m, 1m`);
  } catch (err) {
    console.error('Failed to start bot:', err);
    process.exit(1);
  }
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startBot();
