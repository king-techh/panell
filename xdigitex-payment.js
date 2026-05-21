const axios = require('axios');
const config = require('./config');
const EventEmitter = require('events');

// ─── Share the same paymentEvents emitter from payment.js ──
const { paymentEvents } = require('./payment');

class XdigitexAPI {
  constructor() {
    const apiKey = config.XDIGITEX.apiKey;

    // ─── Xdigitex Pay API Authentication ──────────────────────
    // Per the official docs at https://pay.xdigitex.space/docs:
    //   ALL API keys use the X-API-Key header.
    //   Base URL: https://pay.xdigitex.space/api
    //   Endpoints:
    //     POST /api/payments/initiate  — initiate STK push / card payment
    //     GET  /api/payments/{reference}/status — check payment status
    //
    // Gateway values:
    //   "mobile"    — Pan-Africa Mobile Money (RECOMMENDED, auto-detects network)
    //   "safaricom" — M-Pesa STK push (Safaricom Kenya only)
    //   "airtel"    — Airtel Money Kenya STK push
    //
    // IMPORTANT: The "mobile" gateway is recommended by Xdigitex docs.
    // It auto-detects the mobile network from the phone prefix and
    // supports all 14 African countries. For Kenya, it detects M-Pesa
    // automatically and sends STK push.

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': apiKey,
    };

    console.log(`[Xdigitex] API Key prefix: ${apiKey.substring(0, 3)}... → Using X-API-Key auth`);
    console.log(`[Xdigitex] Default gateway: mobile (Pan-Africa, auto-detect)`);

    this.client = axios.create({
      baseURL: config.XDIGITEX.baseUrl,  // https://pay.xdigitex.space/api
      headers,
      timeout: 30000,
    });

    this.apiKey = apiKey;
    this.pendingPayments = new Map();
    this.activePollers = new Map(); // reference -> interval id
  }

  // ─── Phone Number Formatting for Xdigitex ──────────────
  // Xdigitex requires international format: +254712345678

  formatPhone(phone) {
    let cleaned = phone.replace(/\D/g, '');

    // Kenya
    if (cleaned.startsWith('0') && (cleaned.startsWith('07') || cleaned.startsWith('01'))) {
      cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('+254')) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
      cleaned = '254' + cleaned;
    }
    // Tanzania
    else if (cleaned.startsWith('0') && cleaned.length === 10 && (cleaned.startsWith('06') || cleaned.startsWith('07'))) {
      cleaned = '255' + cleaned.substring(1);
    } else if (cleaned.startsWith('+255')) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('6') && cleaned.length === 9) {
      cleaned = '255' + cleaned;
    }
    // Uganda
    else if (cleaned.startsWith('+256')) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('0') && cleaned.startsWith('07') && cleaned.length === 10) {
      cleaned = '256' + cleaned.substring(1);
    }

    // Validate: must start with a valid country code and have proper length
    const validPrefixes = ['254', '255', '256', '243', '250', '237', '225', '221', '232', '260', '226', '229', '241', '242'];
    const isValid = validPrefixes.some(prefix => cleaned.startsWith(prefix)) && cleaned.length >= 10 && cleaned.length <= 15;

    if (!isValid) {
      throw new Error('Invalid phone number. Use format: 0712345678 (Kenya), 0621234567 (Tanzania), or +254712345678 (international)');
    }

    return '+' + cleaned;
  }

  // ─── Detect network from phone number ───────────────────

  detectNetwork(phone) {
    const cleaned = phone.replace(/\D/g, '');

    if (cleaned.startsWith('254')) {
      const next2 = cleaned.substring(3, 5);
      if (['70', '71', '72', '79', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(next2)) {
        return 'safaricom';
      }
      if (['73', '74', '75', '76', '78'].includes(next2)) {
        return 'airtel';
      }
      return 'safaricom'; // Default to Safaricom for Kenya
    }

    if (cleaned.startsWith('255')) {
      return 'mobile'; // Tanzania - use Pan-Africa mobile gateway
    }

    // Default to mobile (Pan-Africa gateway)
    return 'mobile';
  }

  // ─── Initiate STK Push via Xdigitex Pay ────────────────
  // Per docs: POST /api/payments/initiate
  //
  // STRATEGY: Use "mobile" gateway as PRIMARY (recommended by Xdigitex docs).
  // The "mobile" gateway auto-detects the network from phone prefix.
  // For Kenya +254 numbers, it detects M-Pesa and sends STK push.
  // Falls back to "safaricom" gateway if "mobile" fails.

  async initiateSTKPush(phone, amount, reference, telegramId, planId, firstName) {
    try {
      const formattedPhone = this.formatPhone(phone);
      const network = this.detectNetwork(formattedPhone.replace(/\D/g, ''));

      // ─── Use "mobile" gateway as default ─────────────────
      // The "mobile" gateway is RECOMMENDED by Xdigitex docs.
      // It auto-detects the network from phone prefix.
      // For Kenya: detects M-Pesa/Safaricom automatically.
      // For Tanzania: detects Airtel/Vodacom automatically.
      let gateway = 'mobile';  // Default: Pan-Africa (RECOMMENDED)

      // ─── Build the payload per Xdigitex docs ──────────────
      const webhookBase = config.WEBHOOK.baseURL || 'http://localhost:3000';
      const isLocalhost = webhookBase.includes('localhost') || webhookBase.includes('127.0.0.1');

      const payload = {
        amount: amount,
        currency: 'KES',
        gateway: gateway,
        phone: formattedPhone,
        first_name: firstName || 'Customer',
        description: `Payment for ${planId}`,
      };

      // Only send callback/webhook URLs if they're publicly accessible
      // Xdigitex might reject or have issues with localhost URLs
      if (!isLocalhost) {
        payload.callback_url = `${webhookBase}/webhook/xdigitex`;
        payload.webhook_url = `${webhookBase}/webhook/xdigitex`;
      }

      console.log(`[Xdigitex] Initiating STK Push:`);
      console.log(`  Phone: ${formattedPhone}`);
      console.log(`  Gateway: ${gateway} (Pan-Africa, auto-detect)`);
      console.log(`  Amount: KES ${amount}`);
      console.log(`  Reference: ${reference}`);
      console.log(`  Webhook: ${isLocalhost ? 'skipped (localhost)' : payload.webhook_url}`);
      console.log(`  Network detected: ${network}`);

      // ─── Try PRIMARY gateway first: "mobile" ──────────────
      let response;
      try {
        response = await this.client.post('/payments/initiate', payload);
      } catch (apiErr) {
        // If "mobile" gateway fails, try "safaricom" for Kenya numbers
        if (network === 'safaricom' && apiErr.response) {
          console.warn(`[Xdigitex] "mobile" gateway failed (${apiErr.response.status}), trying "safaricom" gateway...`);
          payload.gateway = 'safaricom';
          response = await this.client.post('/payments/initiate', payload);
          gateway = 'safaricom';
        } else {
          throw apiErr;
        }
      }

      const data = response.data;

      console.log(`[Xdigitex] API Response (status ${response.status}):`, JSON.stringify(data, null, 2));

      // ─── Check for success ──────────────────────────────
      // Per docs, successful response includes:
      //   { success: true, reference: "TX-...", gateway, amount, fee, net_amount, ... }
      // For mobile money: also includes deposit_id, pawa_status, correspondent, message
      const isSuccess = response.status >= 200 && response.status < 300 && (
        data.success === true ||
        data.status === 'success' ||
        data.status === 'INITIATED' ||
        data.status === 'initiated' ||
        data.status === 'pending' ||
        data.status === 'processing' ||
        data.status === 'ACCEPTED' ||
        data.pawa_status === 'ACCEPTED' ||
        (data.reference && !data.error && !data.errors) ||
        (data.deposit_id && !data.error)
      );

      if (isSuccess) {
        const xdgReference = data.reference || data.transaction_id || data.id || data.deposit_id || reference;
        const correspondent = data.correspondent || '';

        // Register pending payment
        this.pendingPayments.set(reference, {
          orderId: reference,
          xdgReference: xdgReference,
          telegramId: String(telegramId),
          planId: planId,
          amount: amount,
          phone: formattedPhone,
          gateway: gateway,
          correspondent: correspondent,
          resolved: false,
          timestamp: Date.now(),
        });

        console.log(`[Xdigitex] STK Push sent! Reference: ${xdgReference} | Gateway: ${gateway} | Correspondent: ${correspondent}`);

        // Start LIVE polling — NO TIMEOUT, poll until resolved
        this._startPolling(reference, xdgReference);

        return {
          success: true,
          transactionId: xdgReference,
          checkoutRequestId: data.checkout_request_id || xdgReference,
          message: data.message || 'STK Push sent successfully',
          gateway: gateway,
          correspondent: correspondent,
          raw: data,
        };
      }

      // ─── Handle failure ─────────────────────────────────
      console.error(`[Xdigitex] STK Push failed (${response.status}):`, JSON.stringify(data));

      const errorMsg = data.message || data.error ||
        (data.errors && Array.isArray(data.errors) ? data.errors.map(e => e.message || e).join('; ') : null) ||
        `STK Push failed (HTTP ${response.status})`;

      return {
        success: false,
        message: errorMsg,
        raw: data,
      };
    } catch (err) {
      return this._handleError(err, 'initiateSTKPush');
    }
  }

  // ─── LIVE Payment Status Polling ───────────────────────
  // NO TIMEOUT — polls every 5 seconds until payment is
  // confirmed or failed. User cancelling on their phone
  // will trigger a "failed" status from the API.

  _startPolling(orderId, xdgReference) {
    this._stopPolling(orderId);

    console.log(`[Xdigitex-Poll] Starting LIVE status check for order ${orderId} (ref: ${xdgReference}) — NO TIMEOUT`);

    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    const poller = setInterval(async () => {
      const pending = this.pendingPayments.get(orderId);

      if (!pending || pending.resolved) {
        console.log(`[Xdigitex-Poll] Stopping poll for ${orderId} — resolved or missing`);
        this._stopPolling(orderId);
        return;
      }

      // Log how long we've been polling (for debugging)
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 30 === 0) { // Log every 30 seconds
        console.log(`[Xdigitex-Poll] Still waiting for ${orderId} — ${elapsed}s elapsed`);
      }

      try {
        const statusResult = await this._checkTransactionStatus(xdgReference);
        const status = statusResult.status;

        if (status === 'completed') {
          console.log(`[Xdigitex-Poll] ✅ Payment CONFIRMED for ${orderId} after ${elapsed}s`);
          this._stopPolling(orderId);
          this._resolvePaymentSuccess(orderId, statusResult.raw);
        } else if (status === 'failed') {
          console.log(`[Xdigitex-Poll] ❌ Payment FAILED for ${orderId} after ${elapsed}s`);
          this._stopPolling(orderId);
          this._resolvePaymentFailed(orderId, statusResult.raw);
        }
        // else: "pending" or "processing" — keep polling forever
      } catch (err) {
        console.warn(`[Xdigitex-Poll] Status check error for ${orderId}: ${err.message}`);
      }
    }, pollInterval);

    this.activePollers.set(orderId, poller);
  }

  _stopPolling(orderId) {
    const poller = this.activePollers.get(orderId);
    if (poller) {
      clearInterval(poller);
      this.activePollers.delete(orderId);
      console.log(`[Xdigitex-Poll] Stopped polling for ${orderId}`);
    }
  }

  // ─── Check Transaction Status ──────────────────────────
  // Per docs: GET /api/payments/{reference}/status
  // Status values: "completed", "failed", "pending", "processing"

  async _checkTransactionStatus(reference) {
    try {
      const response = await this.client.get(`/payments/${reference}/status`);
      const data = response.data;

      const status = (data.status || '').toString().toLowerCase();

      // ─── Completed payment ────────────────────────────
      if (status === 'completed' || status === 'success' || status === 'paid' ||
          status === 'successful' || data.success === true) {
        return {
          status: 'completed',
          success: true,
          raw: data,
        };
      }

      // ─── Failed/cancelled payment ─────────────────────
      if (status === 'failed' || status === 'rejected' || status === 'cancelled' ||
          status === 'expired' || status === 'canceled' ||
          (data.success === false && status !== 'pending' && status !== 'processing')) {
        return {
          status: 'failed',
          success: false,
          raw: data,
        };
      }

      // Return whatever status we got (likely "pending" or "processing")
      return {
        status: status || 'pending',
        success: false,
        raw: data,
      };
    } catch (err) {
      // If 404, the transaction might not be registered yet — keep polling
      if (err.response && err.response.status === 404) {
        return { status: 'pending', raw: {} };
      }
      // Other errors — keep polling
      return { status: 'pending', raw: {} };
    }
  }

  // ─── Resolve Payment Success ───────────────────────────

  _resolvePaymentSuccess(orderId, data) {
    const pending = this.pendingPayments.get(orderId);
    if (!pending || pending.resolved) return;

    pending.resolved = true;
    this.pendingPayments.set(orderId, pending);

    console.log(`[Xdigitex] ✅ Payment CONFIRMED for ${orderId}`);

    paymentEvents.emit('payment_success', {
      externalReference: orderId,
      orderId: orderId,
      telegramId: pending.telegramId,
      planId: pending.planId,
      transactionId: data.reference || data.transaction_id || data.id || pending.xdgReference,
      checkoutRequestId: data.checkout_request_id || data.reference || '',
      mpesaReceipt: data.mpesa_receipt || data.receipt || data.reference || '',
      amount: data.net_amount || data.amount || pending.amount,
      phone: pending.phone,
      paymentMethod: 'xdigitex',
      raw: data,
    });
  }

  // ─── Resolve Payment Failed ────────────────────────────

  _resolvePaymentFailed(orderId, data) {
    const pending = this.pendingPayments.get(orderId);
    if (!pending || pending.resolved) return;

    pending.resolved = true;
    this.pendingPayments.set(orderId, pending);

    const message = data.message || data.resultDesc || 'Payment failed or cancelled';

    console.log(`[Xdigitex] ❌ Payment FAILED for ${orderId} | ${message}`);

    paymentEvents.emit('payment_failed', {
      externalReference: orderId,
      orderId: orderId,
      telegramId: pending.telegramId,
      planId: pending.planId,
      transactionId: data.reference || pending.xdgReference,
      message: message,
      resultCode: data.resultCode || -1,
      paymentMethod: 'xdigitex',
      raw: data,
    });
  }

  // ─── Cancel Payment (user clicks Cancel button) ───────

  cancelPayment(orderId) {
    this._stopPolling(orderId);
    const pending = this.pendingPayments.get(orderId);
    if (pending && !pending.resolved) {
      pending.resolved = true;
      this.pendingPayments.set(orderId, pending);

      console.log(`[Xdigitex] Payment CANCELLED by user for ${orderId}`);

      paymentEvents.emit('payment_failed', {
        externalReference: orderId,
        orderId: orderId,
        telegramId: pending.telegramId,
        planId: pending.planId,
        transactionId: pending.xdgReference,
        message: 'Payment cancelled by user',
        resultCode: 1032,
        paymentMethod: 'xdigitex',
        raw: { status: 'cancelled', message: 'User cancelled' },
      });
    }
  }

  // ─── Cleanup Old Pending Payments (safety net) ────────
  // Only cleans up payments older than 60 minutes that are
  // still pending — this is just a safety cleanup,
  // not a timeout. Normal payments resolve via polling/webhook.

  cleanupPendingPayments() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 60 minutes safety cleanup
    let cleaned = 0;
    for (const [id, payment] of this.pendingPayments.entries()) {
      if (now - payment.timestamp > maxAge && !payment.resolved) {
        console.log(`[Xdigitex] Safety cleanup: resolving old pending payment ${id} as failed`);
        this._resolvePaymentFailed(id, {
          status: 'timeout',
          message: 'Payment session expired. Please try again.',
        });
        this._stopPolling(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[Xdigitex] Cleaned up ${cleaned} old pending payments`);
    }
  }

  // ─── Error Handling ───────────────────────────────────

  _handleError(err, method) {
    if (err.response) {
      const { status, data } = err.response;
      const message = data?.message || data?.error ||
        (data?.errors && Array.isArray(data.errors) ? data.errors.map(e => e.message || e).join('; ') : null) ||
        JSON.stringify(data);
      console.error(`[XdigitexAPI] ${method} failed (${status}): ${message}`);
      return {
        success: false,
        message: `Xdigitex error: ${message}`,
      };
    }
    console.error(`[XdigitexAPI] ${method} failed:`, err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

const instance = new XdigitexAPI();

module.exports = instance;
