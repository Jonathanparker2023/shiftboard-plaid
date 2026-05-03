const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(express.json());
app.use(cors());

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

// Firebase REST API helper (matches frontend DB: shiftly-300fa)
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://shiftly-300fa-default-rtdb.firebaseio.com';

async function writeToFirebase(path, data) {
  try {
    const url = `${FIREBASE_DB_URL}/${path}.json`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) console.error('Firebase write failed:', res.status);
  } catch(e) {
    console.error('Firebase write error:', e.message);
  }
}

async function readFromFirebase(path) {
  try {
    const url = `${FIREBASE_DB_URL}/${path}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch(e) {
    console.error('Firebase read error:', e.message);
    return null;
  }
}

// Load access token from env var, Firebase, or frontend query param
let accessToken = process.env.PLAID_ACCESS_TOKEN || null;

// Load saved access token from Firebase on startup (if not set via env var)
(async function loadToken() {
  if (!accessToken) {
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) { accessToken = t; console.log('Restored Plaid access token from Firebase'); }
  } else {
    console.log('Using Plaid access token from env var');
  }
})();

// Fetch transactions and cache to Firebase for auto-sync
async function syncAndCache(token, startDate, endDate) {
  const response = await plaidClient.transactionsGet({
    access_token: token,
    start_date: startDate,
    end_date: endDate,
    options: { count: 500, offset: 0 },
  });

  const transactions = response.data.transactions
    .filter(tx => tx.amount > 0)
    .map(tx => ({
      date: tx.date,
      name: tx.name || tx.merchant_name || 'Unknown',
      merchant_name: tx.merchant_name || '',
      amount: Math.round(tx.amount * 100) / 100,
      category: tx.category,
      datetime: tx.datetime || tx.authorized_datetime || '',
    }));

  // Write cached transactions to Firebase for auto-sync
  await writeToFirebase('shiftboard/cached_transactions', {
    transactions: transactions,
    startDate: startDate,
    endDate: endDate,
    syncedAt: Date.now(),
  });

  console.log('Synced ' + transactions.length + ' transactions to Firebase (' + startDate + ' to ' + endDate + ')');
  return { transactions, allTx: response.data.transactions };
}

// Step 1: Create a link token
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'shiftboard-user' },
      client_name: 'Cashflow Shiftboard',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: 'https://shiftboard-plaid-1.onrender.com/api/webhook',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Exchange public token for access token
app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    accessToken = response.data.access_token;
    // Persist to Firebase so it survives restarts
    await writeToFirebase('shiftboard/plaid_token', accessToken);
    res.json({ success: true, access_token: accessToken });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Get transactions (accepts token from query param or memory)
app.get('/api/transactions', async (req, res) => {
  // Accept token from frontend query param, env var, or Firebase
  const token = req.query.token || accessToken;
  if (!token) {
    // Try Firebase as last resort
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) { accessToken = t; }
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token. Please link your bank first.' });
    }
  }
  if (token) accessToken = token;

  try {
    const startDate = req.query.start || new Date().toISOString().slice(0,10);
    const endDate = req.query.end || new Date().toISOString().slice(0,10);

    const { transactions, allTx } = await syncAndCache(accessToken, startDate, endDate);

    // Build dynamic spending map
    const spending = {};
    const d = new Date(startDate + 'T12:00:00');
    const end = new Date(endDate + 'T12:00:00');
    while (d <= end) {
      spending[d.toISOString().slice(0,10)] = 0;
      d.setDate(d.getDate() + 1);
    }

    allTx.forEach(function(tx) {
      if (tx.amount > 0 && spending[tx.date] !== undefined) {
        spending[tx.date] += tx.amount;
      }
    });

    Object.keys(spending).forEach(d => {
      spending[d] = Math.round(spending[d] * 100) / 100;
    });

    res.json({ spending, transactions });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    if (err.response && err.response.data && err.response.data.error_code === 'INVALID_ACCESS_TOKEN') {
      accessToken = null;
      await writeToFirebase('shiftboard/plaid_token', null);
    }
    res.status(500).json({ error: err.message });
  }
});

// Debug: Check token status
app.get('/api/token-status', async (req, res) => {
  if (!accessToken) {
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) accessToken = t;
  }

  if (!accessToken) {
    return res.json({ status: 'no_token', cached: false });
  }

  try {
    const response = await plaidClient.accountsGet({ access_token: accessToken });
    res.json({ status: 'valid', accounts: response.data.accounts.length, cached: false });
  } catch (err) {
    const errorCode = err.response?.data?.error_code;
    res.json({ status: 'invalid', error: errorCode, message: err.message, cached: false });
  }
});

// Debug: Check what Plaid has for the current week
app.get('/api/plaid-check', async (req, res) => {
  if (!accessToken) {
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) accessToken = t;
  }
  if (!accessToken) return res.status(400).json({ error: 'No access token' });

  try {
    const now = new Date();
    const easternTime = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const today = new Date(easternTime.getUTCFullYear(), easternTime.getUTCMonth(), easternTime.getUTCDate());
    const day = today.getDay();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - day);
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);

    const startStr = sunday.getFullYear() + '-' + String(sunday.getMonth() + 1).padStart(2, '0') + '-' + String(sunday.getDate()).padStart(2, '0');
    const endStr = saturday.getFullYear() + '-' + String(saturday.getMonth() + 1).padStart(2, '0') + '-' + String(saturday.getDate()).padStart(2, '0');

    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startStr,
      end_date: endStr,
      options: { count: 500, offset: 0 },
    });

    res.json({
      date_range: { start: startStr, end: endStr },
      total: response.data.transactions.length,
      transactions: response.data.transactions.slice(0, 50).map(tx => ({
        date: tx.date,
        name: tx.name || tx.merchant_name,
        amount: tx.amount,
        pending: tx.pending,
      })),
    });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook handler for auto-sync
app.post('/api/webhook', async (req, res) => {
  console.log('Webhook received:', req.body.webhook_type, req.body.webhook_code);
  if (req.body.webhook_type === 'TRANSACTIONS') {
    try {
      if (accessToken) {
        const today = new Date();
        const day = today.getDay();
        const sunday = new Date(today);
        sunday.setDate(today.getDate() - day);
        const saturday = new Date(sunday);
        saturday.setDate(sunday.getDate() + 6);
        const startStr = sunday.getFullYear() + '-' + String(sunday.getMonth() + 1).padStart(2, '0') + '-' + String(sunday.getDate()).padStart(2, '0');
        const endStr = saturday.getFullYear() + '-' + String(saturday.getMonth() + 1).padStart(2, '0') + '-' + String(saturday.getDate()).padStart(2, '0');
        await syncAndCache(accessToken, startStr, endStr);
      }
    } catch(e) { console.error('Webhook sync failed:', e.message); }
  }
  res.json({ received: true });
});

const SYNC_KEY = process.env.SYNC_KEY || '';

let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 6 * 60 * 1000;

// Cron-driven sync — call every 1 min from cron-job.org with ?key=...
// Forces Plaid to pull fresh data from Chime every 6 min (rate-limit safe).
app.get('/api/sync', async (req, res) => {
  if (!SYNC_KEY || req.query.key !== SYNC_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!accessToken) {
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) accessToken = t;
  }
  if (!accessToken) return res.json({ ok: true, synced: 0, note: 'no token' });

  if (Date.now() - lastRefreshAt > REFRESH_MIN_INTERVAL_MS) {
    try {
      // accountsBalanceGet forces Plaid to talk to Chime in real-time;
      // side effect: often triggers fresh transaction pull
      await plaidClient.accountsBalanceGet({ access_token: accessToken });
      lastRefreshAt = Date.now();
      console.log('Triggered balance refresh (side-effect: transactions pull)');
    } catch (e) {
      console.error('Balance refresh failed:', e.response?.data?.error_code || e.message);
    }
  }

  try {
    // Accept optional date param (YYYY-MM-DD) from client, or calculate from Eastern timezone
    const dateParam = req.query.date;
    let today;
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const [y, m, d] = dateParam.split('-').map(Number);
      today = new Date(y, m - 1, d);
    } else {
      // Default to Eastern timezone (UTC-4/5 depending on DST)
      const now = new Date();
      const easternTime = new Date(now.getTime() - 5 * 60 * 60 * 1000); // UTC-5 base
      today = new Date(easternTime.getUTCFullYear(), easternTime.getUTCMonth(), easternTime.getUTCDate());
    }

    const day = today.getDay();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - day);
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);

    const startStr = sunday.getFullYear() + '-' + String(sunday.getMonth() + 1).padStart(2, '0') + '-' + String(sunday.getDate()).padStart(2, '0');
    const endStr = saturday.getFullYear() + '-' + String(saturday.getMonth() + 1).padStart(2, '0') + '-' + String(saturday.getDate()).padStart(2, '0');

    const { transactions } = await syncAndCache(accessToken, startStr, endStr);
    res.json({ ok: true, synced: transactions.length });
  } catch (err) {
    if (err.response && err.response.data && err.response.data.error_code === 'INVALID_ACCESS_TOKEN') {
      accessToken = null;
      await writeToFirebase('shiftboard/plaid_token', null);
    }
    console.error('Cron sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Force refresh — bypasses the 6-min throttle. Used by manual "Sync Chime" click.
app.get('/api/force-refresh', async (req, res) => {
  if (!accessToken) {
    const t = await readFromFirebase('shiftboard/plaid_token');
    if (t) accessToken = t;
  }
  if (!accessToken) return res.status(400).json({ error: 'No access token' });

  try {
    await plaidClient.accountsBalanceGet({ access_token: accessToken });
    lastRefreshAt = Date.now();
    console.log('Force balance refresh triggered');
    await new Promise(r => setTimeout(r, 3000));
    res.json({ ok: true, refreshed: true });
  } catch (e) {
    const errCode = e.response?.data?.error_code || e.message;
    console.error('Force refresh failed:', errCode);
    res.status(500).json({ ok: false, error: errCode });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Shiftboard Plaid backend running', hasToken: !!accessToken }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
