const axios = require('axios');
const express = require('express');
const config = require('./config');
const EventEmitter = require('events');

// ─── Payment Event Emitter ──────────────────────────────
const paymentEvents = new EventEmitter();

class SwiftWalletAPI {
  constructor() {
    this.client = axios.create({
      baseURL: config.SWIFTWALLET.baseUrl,
      headers: {
        Authorization: `Bearer ${config.SWIFTWALLET.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    });

    this.webhookPort = config.WEBHOOK.port || 3000;
    this.webhookBaseURL = config.WEBHOOK.baseURL || 'http://localhost:3000';
    this.pendingPayments = new Map();
    this.activePollers = new Map(); // orderId -> interval id
  }

  // ─── Start Webhook Server ──────────────────────────────

  startWebhookServer() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // SwiftWallet v3 webhook callback endpoint
    app.post('/webhook', (req, res) => {
      const data = req.body;
      console.log('[Webhook] Received SwiftWallet callback:', JSON.stringify(data, null, 2));

      try {
        const externalReference = data.external_reference || data.reference_number;
        const status = (data.status || '').toString().toLowerCase();
        const mpesaResponse = data.mpesa_response || data.result || {};
        const isSuccess = mpesaResponse.success === true || status === 'completed';
        const isFailed = mpesaResponse.success === false || status === 'failed';

        if (!externalReference) {
          console.warn('[Webhook] No external_reference in callback payload');
          res.status(200).send('OK');
          return;
        }

        const pending = this.pendingPayments.get(externalReference);
        if (!pending) {
          console.warn(`[Webhook] No pending payment for reference: ${externalReference}`);
          res.status(200).send('OK');
          return;
        }

        if (pending.resolved) {
          console.log(`[Webhook] Payment ${externalReference} already resolved, ignoring duplicate`);
          res.status(200).send('OK');
          return;
        }

        if (isSuccess) {
          this._resolvePaymentSuccess(externalReference, data);
        } else if (isFailed) {
          this._resolvePaymentFailed(externalReference, data);
        } else {
          console.log(`[Webhook] Unknown/pending status '${status}' for ${externalReference} — continuing to poll`);
        }

        res.status(200).send('OK');
      } catch (err) {
        console.error('[Webhook] Error processing SwiftWallet callback:', err.message);
        res.status(200).send('OK');
      }
    });

    // Xdigitex Pay webhook callback endpoint
    app.post('/webhook/xdigitex', (req, res) => {
      const data = req.body;
      console.log('[Webhook] Received Xdigitex callback:', JSON.stringify(data, null, 2));

      try {
        const reference = data.reference || data.transaction_id || data.id || data.order_id;
        const status = (data.status || '').toString().toLowerCase();
        const isSuccess = status === 'completed' || status === 'success' || status === 'paid' || status === 'successful' || data.success === true;
        const isFailed = status === 'failed' || status === 'rejected' || status === 'cancelled' || status === 'expired' || data.success === false;

        if (!reference) {
          console.warn('[Webhook/Xdigitex] No reference in callback payload');
          res.status(200).send('OK');
          return;
        }

        // Find the pending payment — it may be stored under the orderId (our reference)
        const xdigitexPayment = require('./xdigitex-payment');
        let pending = xdigitexPayment.pendingPayments.get(reference);

        // If not found by xdg reference, search by orderId
        if (!pending) {
          for (const [orderId, p] of xdigitexPayment.pendingPayments.entries()) {
            if (p.xdgReference === reference || orderId === reference) {
              pending = p;
              break;
            }
          }
        }

        if (!pending || pending.resolved) {
          console.warn(`[Webhook/Xdigitex] No pending/resolvable payment for reference: ${reference}`);
          res.status(200).send('OK');
          return;
        }

        if (isSuccess) {
          xdigitexPayment._resolvePaymentSuccess(pending.orderId, data);
        } else if (isFailed) {
          xdigitexPayment._resolvePaymentFailed(pending.orderId, data);
        } else {
          console.log(`[Webhook/Xdigitex] Unknown/pending status '${status}' for ${reference} — continuing to poll`);
        }

        res.status(200).send('OK');
      } catch (err) {
        console.error('[Webhook/Xdigitex] Error processing callback:', err.message);
        res.status(200).send('OK');
      }
    });

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', pending: this.pendingPayments.size, uptime: process.uptime() });
    });

    // Start server
    app.listen(this.webhookPort, '0.0.0.0', () => {
      console.log(`[Webhook] Server listening on port ${this.webhookPort}`);
      console.log(`[Webhook] SwiftWallet callback: ${this.webhookBaseURL}/webhook`);
      console.log(`[Webhook] Xdigitex callback: ${this.webhookBaseURL}/webhook/xdigitex`);
    });
  }

  // ─── STK Push (SwiftWallet v3) ─────────────────────────

  async initiateSTKPush(phone, amount, reference, telegramId, planId) {
    try {
      const formattedPhone = this._formatPhone(phone);

      const callbackUrl = `${this.webhookBaseURL}/webhook`;

      const payload = {
        amount: amount,
        phone_number: formattedPhone,
        account_reference: reference,
        transaction_desc: `Payment for ${planId}`,
        callback_url: callbackUrl,
        external_reference: reference,
      };

      console.log(`[STK] Initiating v3 STK Push:`);
      console.log(`  Phone: ${formattedPhone}`);
      console.log(`  Amount: KES ${amount}`);
      console.log(`  Reference: ${reference}`);
      console.log(`  Callback: ${callbackUrl}`);

      const response = await this.client.post('/v3/stk-initiate/', payload);

      const data = response.data;

      console.log(`[STK] API Response:`, JSON.stringify(data, null, 2));

      if (data.success === true || data.status === 'INITIATED') {
        const transactionId = data.transaction_id || data.id;
        const checkoutRequestId = data.checkout_request_id || '';

        // Register pending payment
        this.pendingPayments.set(reference, {
          orderId: reference,
          telegramId: String(telegramId),
          planId: planId,
          amount: amount,
          phone: formattedPhone,
          transactionId: transactionId,
          checkoutRequestId: checkoutRequestId,
          resolved: false,
          timestamp: Date.now(),
        });

        console.log(`[STK] STK Push sent! Transaction ID: ${transactionId} | CheckoutRequestID: ${checkoutRequestId}`);

        // ─── START LIVE POLLING ────────────
        this._startPolling(reference, transactionId);

        return {
          success: true,
          transactionId: transactionId,
          checkoutRequestId: checkoutRequestId,
          message: data.message || 'STK Push sent successfully',
          raw: data,
        };
      }

      console.error(`[STK] STK Push failed:`, JSON.stringify(data));

      return {
        success: false,
        message: data.error || data.message || 'STK Push initiation failed',
        errorCode: data.error_code || null,
        raw: data,
      };
    } catch (err) {
      return this._handleError(err, 'initiateSTKPush');
    }
  }

  // ─── Live Payment Status Polling ───────────────────────
  // Polls every 3 seconds for 3 minutes.
  // This is the PRIMARY mechanism for detecting payment status.
  // Webhook serves as backup when publicly accessible.

  _startPolling(orderId, transactionId) {
    this._stopPolling(orderId);

    console.log(`[Poll] Starting live status check for order ${orderId} (tx: ${transactionId})`);

    const maxDuration = 3 * 60 * 1000; // 3 minutes
    const pollInterval = 3000; // 3 seconds — faster polling for quicker detection
    const startTime = Date.now();

    const poller = setInterval(async () => {
      const pending = this.pendingPayments.get(orderId);

      if (!pending || pending.resolved) {
        console.log(`[Poll] Stopping poll for ${orderId} — already resolved or missing`);
        this._stopPolling(orderId);
        return;
      }

      if (Date.now() - startTime > maxDuration) {
        console.log(`[Poll] Timeout for ${orderId} — 3 minutes exceeded`);
        this._stopPolling(orderId);
        this._resolvePaymentFailed(orderId, {
          status: 'timeout',
          mpesa_response: { resultCode: -1, resultDesc: 'Payment timed out (3 minutes). Please try again.' },
        });
        return;
      }

      try {
        const statusResult = await this._checkTransactionStatus(orderId);
        const txStatus = statusResult.status;
        console.log(`[Poll] Status for order ${orderId}: ${txStatus}`);

        if (txStatus === 'completed') {
          console.log(`[Poll] Payment CONFIRMED for ${orderId}`);
          this._stopPolling(orderId);
          this._resolvePaymentSuccess(orderId, statusResult.raw);
        } else if (txStatus === 'failed') {
          console.log(`[Poll] Payment FAILED for ${orderId}`);
          this._stopPolling(orderId);
          this._resolvePaymentFailed(orderId, statusResult.raw);
        }
        // else: "pending" — continue polling
      } catch (err) {
        console.warn(`[Poll] Status check error for ${orderId}: ${err.message}`);
      }
    }, pollInterval);

    this.activePollers.set(orderId, poller);
  }

  _stopPolling(orderId) {
    const poller = this.activePollers.get(orderId);
    if (poller) {
      clearInterval(poller);
      this.activePollers.delete(orderId);
      console.log(`[Poll] Stopped polling for ${orderId}`);
    }
  }

  // ─── Check Transaction Status via SwiftWallet v3 API ──────
  //
  // GET /v3/transactions/?external_reference={reference}
  // Status values: "completed", "failed", "pending"
  // M-Pesa resultCodes: 0 = success, 1032 = cancelled by user,
  //   1037 = timeout/no response, 1 = insufficient balance

  async _checkTransactionStatus(externalReference) {
    try {
      const response = await this.client.get('/v3/transactions/', {
        params: { external_reference: externalReference },
      });

      const data = response.data;

      if (!data.success) {
        throw new Error(data.message || 'Transaction lookup failed');
      }

      const tx = data.data?.transaction || data.data?.transactions?.[0];

      if (!tx) {
        return { status: 'pending', raw: data };
      }

      const status = (tx.status || '').toString().toLowerCase();
      const mpesaResponse = tx.mpesa_response || {};

      // Check for M-Pesa cancellation codes even if status says pending
      const resultCode = mpesaResponse.resultCode;
      if (resultCode === '1032' || resultCode === 1032) {
        // User cancelled the STK push on their phone
        return {
          status: 'failed',
          success: false,
          raw: {
            ...tx,
            mpesa_response: { ...mpesaResponse, resultDesc: mpesaResponse.resultDesc || 'The request was cancelled by the user' },
            result: mpesaResponse,
            transaction_id: tx.id,
          },
        };
      }

      // Check for other failure codes
      if (resultCode === '1037' || resultCode === 1037) {
        return {
          status: 'failed',
          success: false,
          raw: {
            ...tx,
            mpesa_response: { ...mpesaResponse, resultDesc: mpesaResponse.resultDesc || 'The request timed out' },
            result: mpesaResponse,
            transaction_id: tx.id,
          },
        };
      }

      // Check for insufficient balance / other failures
      if (resultCode === '1' || resultCode === 1) {
        return {
          status: 'failed',
          success: false,
          raw: {
            ...tx,
            mpesa_response: { ...mpesaResponse, resultDesc: mpesaResponse.resultDesc || 'Insufficient balance' },
            result: mpesaResponse,
            transaction_id: tx.id,
          },
        };
      }

      // Check for result code 0 = success
      if (resultCode === '0' || resultCode === 0) {
        return {
          status: 'completed',
          success: true,
          raw: {
            ...tx,
            mpesa_response: mpesaResponse,
            result: mpesaResponse,
            transaction_id: tx.id,
            checkout_request_id: tx.checkout_request_id,
          },
        };
      }

      // Check explicit status fields
      if (status === 'completed' || status === 'success' || status === 'paid') {
        return {
          status: 'completed',
          success: true,
          raw: {
            ...tx,
            mpesa_response: mpesaResponse,
            result: mpesaResponse,
            transaction_id: tx.id,
            checkout_request_id: tx.checkout_request_id,
          },
        };
      }

      if (status === 'failed' || status === 'cancelled' || status === 'rejected') {
        return {
          status: 'failed',
          success: false,
          raw: {
            ...tx,
            mpesa_response: mpesaResponse,
            result: mpesaResponse,
            transaction_id: tx.id,
          },
        };
      }

      const enrichedRaw = {
        ...tx,
        mpesa_response: mpesaResponse,
        result: mpesaResponse,
        transaction_id: tx.id,
        checkout_request_id: tx.checkout_request_id,
      };

      return {
        status: status || 'pending',
        success: mpesaResponse.success,
        raw: enrichedRaw,
      };
    } catch (err) {
      // Try listing recent transactions as fallback
      try {
        const response = await this.client.get('/v3/transactions/', {
          params: { limit: 5 },
        });

        const txs = response.data?.data?.transactions || [];
        const match = txs.find(t =>
          t.reference_number === externalReference ||
          t.external_reference === externalReference
        );

        if (match) {
          const status = (match.status || '').toString().toLowerCase();
          const mpesaResponse = match.mpesa_response || {};

          // Check cancellation code
          const resultCode = mpesaResponse.resultCode;
          if (resultCode === '1032' || resultCode === 1032) {
            return {
              status: 'failed',
              success: false,
              raw: {
                ...match,
                mpesa_response: { ...mpesaResponse, resultDesc: mpesaResponse.resultDesc || 'Cancelled by user' },
                result: mpesaResponse,
                transaction_id: match.id,
              },
            };
          }

          const enrichedRaw = {
            ...match,
            mpesa_response: mpesaResponse,
            result: mpesaResponse,
            transaction_id: match.id,
            checkout_request_id: match.checkout_request_id,
          };

          return {
            status: status,
            success: mpesaResponse.success,
            raw: enrichedRaw,
          };
        }

        return { status: 'pending', raw: {} };
      } catch (err2) {
        return { status: 'pending', raw: {} };
      }
    }
  }

  // ─── Resolve Payment Success ───────────────────────────

  _resolvePaymentSuccess(externalReference, data) {
    const pending = this.pendingPayments.get(externalReference);
    if (!pending || pending.resolved) return;

    pending.resolved = true;
    this.pendingPayments.set(externalReference, pending);

    const mpesaResponse = data.mpesa_response || data.result || {};
    const mpesaReceipt = mpesaResponse.mpesaReceiptNumber || mpesaResponse.transactionReceipt || data.mpesa_receipt_number || '';
    const paidAmount = mpesaResponse.amount || data.amount || pending.amount;
    const paidPhone = data.phone_number || pending.phone;

    console.log(`[Payment] CONFIRMED for ${externalReference} | Receipt: ${mpesaReceipt} | Amount: ${paidAmount}`);

    paymentEvents.emit('payment_success', {
      externalReference,
      orderId: externalReference,
      telegramId: pending.telegramId,
      planId: pending.planId,
      transactionId: data.transaction_id || pending.transactionId,
      checkoutRequestId: data.checkout_request_id || '',
      mpesaReceipt,
      amount: paidAmount,
      phone: paidPhone,
      raw: data,
    });
  }

  // ─── Resolve Payment Failed ────────────────────────────

  _resolvePaymentFailed(externalReference, data) {
    const pending = this.pendingPayments.get(externalReference);
    if (!pending || pending.resolved) return;

    pending.resolved = true;
    this.pendingPayments.set(externalReference, pending);

    const mpesaResponse = data.mpesa_response || data.result || {};
    const resultDesc = mpesaResponse.resultDesc || data.resultDesc || 'Payment failed or cancelled';
    const resultCode = mpesaResponse.resultCode || data.resultCode;

    console.log(`[Payment] FAILED for ${externalReference} | Code: ${resultCode} | ${resultDesc}`);

    paymentEvents.emit('payment_failed', {
      externalReference,
      orderId: externalReference,
      telegramId: pending.telegramId,
      planId: pending.planId,
      transactionId: data.transaction_id || pending.transactionId,
      message: resultDesc,
      resultCode,
      raw: data,
    });
  }

  // ─── Phone Number Formatting ──────────────────────────

  _formatPhone(phone) {
    let cleaned = phone.replace(/\D/g, '');

    if (cleaned.startsWith('0')) {
      cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('+254')) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
      cleaned = '254' + cleaned;
    }

    if (!cleaned.startsWith('254') || cleaned.length !== 12) {
      throw new Error('Invalid Kenyan phone number. Use format: 07XXXXXXXX or 254XXXXXXXXX');
    }

    return cleaned;
  }

  // ─── Cancel Payment ────────────────────────────────────

  cancelPayment(orderId) {
    this._stopPolling(orderId);
    const pending = this.pendingPayments.get(orderId);
    if (pending && !pending.resolved) {
      pending.resolved = true;
      this.pendingPayments.set(orderId, pending);
    }
  }

  // ─── Cleanup Old Pending Payments ─────────────────────

  cleanupPendingPayments() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    let cleaned = 0;
    for (const [id, payment] of this.pendingPayments.entries()) {
      if (now - payment.timestamp > maxAge) {
        this._stopPolling(id);
        this.pendingPayments.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[Payment] Cleaned up ${cleaned} old pending payments`);
    }
  }

  // ─── Error Handling ───────────────────────────────────

  _handleError(err, method) {
    if (err.response) {
      const { status, data } = err.response;
      const message = data?.error || data?.message || data?.details?.message || JSON.stringify(data);
      const errorCode = data?.error_code || null;
      console.error(`[SwiftWalletAPI] ${method} failed (${status}): ${message}`);
      return {
        success: false,
        message: `Payment error: ${message}`,
        errorCode,
      };
    }
    console.error(`[SwiftWalletAPI] ${method} failed:`, err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

const instance = new SwiftWalletAPI();

module.exports = instance;
module.exports.paymentEvents = paymentEvents;
