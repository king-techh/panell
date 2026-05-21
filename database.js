const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default database structure
const DEFAULT_DB = {
  users: {},
  orders: {},
};

class Database {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_DB, ...parsed };
      }
    } catch (err) {
      console.error('Failed to load database, creating new one:', err.message);
    }
    return { ...DEFAULT_DB };
  }

  _save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save database:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // ─── User Operations ──────────────────────────────────
  // ═══════════════════════════════════════════════════════
  //
  // When a trial or subscription expires and the user has
  // no active paid subscriptions, the user AND their server
  // are automatically deleted from both the Pterodactyl
  // panel and this database.
  //
  // ═══════════════════════════════════════════════════════

  getUser(telegramId) {
    return this.data.users[String(telegramId)] || null;
  }

  setUser(telegramId, userData) {
    this.data.users[String(telegramId)] = userData;
    this._save();
    return userData;
  }

  upsertUser(telegramId, updates) {
    const existing = this.getUser(telegramId) || {
      telegramId: String(telegramId),
      username: '',
      firstName: '',
      pteroUserId: null,
      pteroUsername: '',
      pteroPassword: '',
      pteroEmail: '',
      trialUsed: false,
      trialExpiresAt: null,
      trialServerId: null,
      trialSuspended: false,
      isAdmin: false,
      subscriptions: [],
      mainMessageId: null,
      createdAt: new Date().toISOString(),
    };
    const updated = { ...existing, ...updates };
    this.data.users[String(telegramId)] = updated;
    this._save();
    return updated;
  }

  isTrialUsed(telegramId) {
    const user = this.getUser(telegramId);
    return user ? user.trialUsed : false;
  }

  useTrial(telegramId, pteroUserId, pteroUsername, pteroPassword, pteroEmail, trialServerId, trialExpiresAt) {
    return this.upsertUser(telegramId, {
      trialUsed: true,
      trialExpiresAt: trialExpiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      trialServerId: trialServerId || null,
      trialSuspended: false,
      pteroUserId,
      pteroUsername,
      pteroPassword,
      pteroEmail,
    });
  }

  // ─── Admin Operations ─────────────────────────────────

  isAdmin(telegramId) {
    const user = this.getUser(telegramId);
    return user ? user.isAdmin === true : false;
  }

  setAdmin(telegramId, isAdmin) {
    return this.upsertUser(telegramId, { isAdmin: isAdmin });
  }

  // ─── Subscription Operations ──────────────────────────

  addSubscription(telegramId, subscription) {
    const user = this.getUser(telegramId);
    if (!user) return null;
    const subs = user.subscriptions || [];
    subs.push({
      ...subscription,
      createdAt: new Date().toISOString(),
      active: true,
    });
    return this.upsertUser(telegramId, { subscriptions: subs });
  }

  getActiveSubscriptions(telegramId) {
    const user = this.getUser(telegramId);
    if (!user) return [];
    return (user.subscriptions || []).filter((s) => s.active);
  }

  deactivateSubscription(telegramId, subIndex) {
    const user = this.getUser(telegramId);
    if (!user || !user.subscriptions[subIndex]) return null;
    user.subscriptions[subIndex].active = false;
    return this.upsertUser(telegramId, { subscriptions: user.subscriptions });
  }

  // ─── Message Tracking ─────────────────────────────────

  setMainMessageId(telegramId, messageId) {
    return this.upsertUser(telegramId, { mainMessageId: messageId });
  }

  getMainMessageId(telegramId) {
    const user = this.getUser(telegramId);
    return user ? user.mainMessageId : null;
  }

  // ─── Order Operations ─────────────────────────────────

  createOrder(orderId, orderData) {
    this.data.orders[orderId] = {
      ...orderData,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this._save();
    return this.data.orders[orderId];
  }

  getOrder(orderId) {
    return this.data.orders[orderId] || null;
  }

  updateOrder(orderId, updates) {
    if (!this.data.orders[orderId]) return null;
    this.data.orders[orderId] = { ...this.data.orders[orderId], ...updates };
    this._save();
    return this.data.orders[orderId];
  }

  // ─── Get All Users ────────────────────────────────────

  getAllUsers() {
    return Object.values(this.data.users);
  }

  // ─── Delete User from Database ────────────────────────
  // Used when a trial/subscription expires — removes the
  // user record entirely along with their Pterodactyl
  // server and account.

  deleteUser(telegramId) {
    const tid = String(telegramId);
    if (this.data.users[tid]) {
      delete this.data.users[tid];
      this._save();
      console.log(`[DB] Deleted user ${tid} from database`);
      return true;
    }
    return false;
  }

  // ─── Cleanup ──────────────────────────────────────────
  // Marks expired subscriptions as inactive.

  cleanupExpired() {
    const now = new Date();
    let cleaned = 0;

    for (const [tid, user] of Object.entries(this.data.users)) {
      // Check subscription expiry — deactivate expired ones
      if (user.subscriptions) {
        let updated = false;
        for (let i = 0; i < user.subscriptions.length; i++) {
          const sub = user.subscriptions[i];
          if (sub.active && sub.expiresAt && new Date(sub.expiresAt) < now) {
            user.subscriptions[i].active = false;
            updated = true;
            cleaned++;
          }
        }
        if (updated) {
          this.upsertUser(tid, { subscriptions: user.subscriptions });
        }
      }
    }

    // Clean old pending orders (> 30 minutes)
    for (const [oid, order] of Object.entries(this.data.orders)) {
      if (order.status === 'pending') {
        const age = now - new Date(order.createdAt);
        if (age > 30 * 60 * 1000) {
          this.data.orders[oid].status = 'expired';
        }
      }
    }
    this._save();

    return cleaned;
  }

  // ─── Stats ────────────────────────────────────────────

  getStats() {
    const users = Object.values(this.data.users);
    return {
      totalUsers: users.length,
      trialUsers: users.filter((u) => u.trialUsed).length,
      activeSubscriptions: users.reduce(
        (acc, u) => acc + (u.subscriptions ? u.subscriptions.filter((s) => s.active).length : 0),
        0
      ),
      totalOrders: Object.keys(this.data.orders).length,
      adminUsers: users.filter((u) => u.isAdmin).length,
    };
  }
}

module.exports = new Database();
