const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(express.json());
app.use(cors());

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'development'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '69caec649a4613000d81fe4c',
      'PLAID-SECRET': process.env.PLAID_SECRET || '2124a58d6d1a455cdf9a1c79c8abc0',
    },
  },
});

const plaidClient = new PlaidApi(config);

// Persist access token to Firebase so it survives Render restarts
const admin = require('firebase-admin');
let firebaseApp;
try {
  firebaseApp = admin.initializeApp({
    databaseURL: process.env.FIREBASE_DB_URL || 'https://cashflow-shiftboard-default-rtdb.firebaseio.com'
  });
} catch(e) {
  firebaseApp = admin.app();
}
const fbDb = admin.database();

let accessToken = null;

// Load saved access token from Firebase on startup
(async function loadToken() {
  try {
    const snap = await fbDb.ref('shiftboard/plaid_token').once('value');
    const t = snap.val();
    if (t) { accessToken = t; console.log('Restored Plaid access token from Firebase'); }
  } catch(e) { console.error('Could not load saved token:', e.message); }
})();

// Step 1: Create a link token (frontend uses this to open Plaid Link)
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'shiftboard-user' },
      client_name: 'Cashflow Shiftboard',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
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
    try { await fbDb.ref('shiftboard/plaid_token').set(accessToken); } catch(e) {}
    res.json({ success: true });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Get transactions for the current week (dynamic dates from query params)
app.get('/api/transactions', async (req, res) => {
  // Try loading token from Firebase if not in memory
  if (!accessToken) {
    try {
      const snap = await fbDb.ref('shiftboard/plaid_token').once('value');
      accessToken = snap.val();
    } catch(e) {}
  }
  if (!accessToken) {
    return res.status(400).json({ error: 'No access token. Please link your bank first.' });
  }
  try {
    const startDate = req.query.start || new Date().toISOString().slice(0,10);
    const endDate = req.query.end || new Date().toISOString().slice(0,10);
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset: 0 },
    });

    // Build dynamic dayMap from start/end range (no more hardcoded dates)
    const spending = {};
    const d = new Date(startDate + 'T12:00:00');
    const end = new Date(endDate + 'T12:00:00');
    while (d <= end) {
      spending[d.toISOString().slice(0,10)] = 0;
      d.setDate(d.getDate() + 1);
    }

    // Group spending by day (only positive amounts = spending, exclude income deposits)
    response.data.transactions.forEach(function(tx) {
      if (tx.amount > 0 && spending[tx.date] !== undefined) {
        spending[tx.date] += tx.amount;
      }
    });

    // Round each day
    Object.keys(spending).forEach(d => {
      spending[d] = Math.round(spending[d] * 100) / 100;
    });

    res.json({
      spending,
      transactions: response.data.transactions
        .filter(tx => tx.amount > 0)
        .map(tx => ({
          date: tx.date,
          name: tx.name || tx.merchant_name || 'Unknown',
          merchant_name: tx.merchant_name,
          amount: Math.round(tx.amount * 100) / 100,
          category: tx.category,
          datetime: tx.datetime || tx.authorized_datetime || '',
        }))
    });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    // If token is invalid, clear it
    if (err.response && err.response.data && err.response.data.error_code === 'INVALID_ACCESS_TOKEN') {
      accessToken = null;
      try { await fbDb.ref('shiftboard/plaid_token').remove(); } catch(e) {}
    }
    res.status(500).json({ error: err.message });
  }
});

// Accept token from frontend (restore saved token)
app.post('/api/save-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (token) {
      accessToken = token;
      await fbDb.ref('shiftboard/plaid_token').set(token);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'No token provided' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Shiftboard Plaid backend running', hasToken: !!accessToken }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
