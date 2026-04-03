const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(express.json());
app.use(cors());

// Firebase REST API (no SDK needed — just HTTP writes)
const FIREBASE_DB_URL = 'https://shiftly-300fa-default-rtdb.firebaseio.com';

// Env vars set on Render dashboard
const SYNC_KEY = process.env.SYNC_KEY || '';
const PLAID_ACCESS_TOKEN_ENV = process.env.PLAID_ACCESS_TOKEN || '';

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '69caec649a4613000d81fe4c',
      'PLAID-SECRET': process.env.PLAID_SECRET || '2124a58d6d1a455cdf9a1c79c8abc0',
    },
  },
});

const plaidClient = new PlaidApi(config);

// In-memory token (set from exchange or env var)
let accessToken = PLAID_ACCESS_TOKEN_ENV || null;

// ── Firebase REST helper ──
async function writeToFirebase(path, data) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Firebase write failed: ' + res.status);
  return res.json();
}

// ── Fetch transactions from Plaid and cache to Firebase ──
async function syncAndCache(token) {
  // Calculate current week Sun-Sat
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - dayOfWeek);
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);

  const startDate = sunday.toISOString().slice(0, 10);
  const endDate = saturday.toISOString().slice(0, 10);

  const response = await plaidClient.transactionsGet({
    access_token: token,
    start_date: startDate,
    end_date: endDate,
    options: { count: 100, offset: 0 },
  });

  const transactions = response.data.transactions.map(tx => ({
    date: tx.date,
    name: tx.name,
    amount: tx.amount,
    category: tx.category,
    merchant_name: tx.merchant_name || '',
    datetime: tx.datetime || tx.authorized_datetime || '',
  }));

  // Write cached transactions to Firebase
  await writeToFirebase('shiftboard/cached_transactions', {
    transactions: transactions,
    startDate: startDate,
    endDate: endDate,
    syncedAt: Date.now(),
  });

  // Write sync status
  await writeToFirebase('shiftboard/sync_status', {
    lastSync: Date.now(),
    status: 'ok',
    txCount: transactions.length,
  });

  console.log('Synced ' + transactions.length + ' transactions to Firebase (' + startDate + ' to ' + endDate + ')');
  return transactions;
}

// ── Step 1: Create a link token (with webhook for auto-sync) ──
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'shiftboard-user' },
      client_name: 'Cashflow Shiftboard',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: 'https://shiftboard-plaid.onrender.com/api/webhook',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2: Exchange public token for access token ──
app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    accessToken = response.data.access_token;
    res.json({ success: true, access_token: accessToken });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 3: Get transactions for the current week ──
app.get('/api/transactions', async (req, res) => {
  const token = req.query.token || accessToken;
  if (!token) {
    return res.status(400).json({ error: 'No account connected. Please link your bank first.' });
  }
  accessToken = token;
  try {
    const startDate = req.query.start || '2026-03-29';
    const endDate = req.query.end || '2026-04-04';
    const response = await plaidClient.transactionsGet({
      access_token: token,
      start_date: startDate,
      end_date: endDate,
      options: { count: 100, offset: 0 },
    });

    const dayMap = {
      '2026-03-29': 'Sun', '2026-03-30': 'Mon', '2026-03-31': 'Tue',
      '2026-04-01': 'Wed', '2026-04-02': 'Thu', '2026-04-03': 'Fri', '2026-04-04': 'Sat'
    };

    const spending = {};
    Object.keys(dayMap).forEach(d => { spending[d] = 0; });

    response.data.transactions.forEach(function(tx) {
      if (tx.amount > 0 && spending[tx.date] !== undefined) {
        spending[tx.date] += tx.amount;
      }
    });

    Object.keys(spending).forEach(d => {
      spending[d] = Math.round(spending[d]);
    });

    res.json({
      spending,
      transactions: response.data.transactions.map(tx => ({
        date: tx.date,
        name: tx.name,
        amount: tx.amount,
        category: tx.category,
      }))
    });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Plaid Webhook (receives automatic transaction alerts) ──
app.post('/api/webhook', async (req, res) => {
  const { webhook_type, webhook_code } = req.body;
  console.log('Plaid webhook received:', webhook_type, webhook_code);

  if (webhook_type === 'TRANSACTIONS') {
    const token = accessToken || PLAID_ACCESS_TOKEN_ENV;
    if (!token) {
      console.error('Webhook: no access token available');
      return res.json({ received: true, synced: false });
    }
    try {
      // Small delay so Plaid finalizes the transactions
      await new Promise(r => setTimeout(r, 3000));
      await syncAndCache(token);
      res.json({ received: true, synced: true });
    } catch (err) {
      console.error('Webhook sync error:', err.message);
      res.json({ received: true, synced: false, error: err.message });
    }
  } else {
    res.json({ received: true });
  }
});

// ── Cron Sync (hit by cron-job.org every 6 hours) ──
app.get('/api/sync', async (req, res) => {
  if (!SYNC_KEY || req.query.key !== SYNC_KEY) {
    return res.status(403).json({ error: 'Invalid sync key' });
  }
  const token = accessToken || PLAID_ACCESS_TOKEN_ENV;
  if (!token) {
    return res.status(400).json({ error: 'No access token configured. Set PLAID_ACCESS_TOKEN env var.' });
  }
  try {
    const txs = await syncAndCache(token);
    res.json({ success: true, transactions: txs.length });
  } catch (err) {
    console.error('Cron sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Register webhook for existing Plaid item ──
app.post('/api/register-webhook', async (req, res) => {
  const token = accessToken || PLAID_ACCESS_TOKEN_ENV;
  if (!token) {
    return res.status(400).json({ error: 'No access token' });
  }
  try {
    await plaidClient.itemWebhookUpdate({
      access_token: token,
      webhook: 'https://shiftboard-plaid.onrender.com/api/webhook',
    });
    res.json({ success: true, message: 'Webhook registered' });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Shiftboard Plaid backend running', hasToken: !!accessToken }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
