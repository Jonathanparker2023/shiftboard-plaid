const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(express.json());
app.use(cors());

const env = process.env.PLAID_ENV === 'production' ? PlaidEnvironments.production : PlaidEnvironments.sandbox;

const config = new Configuration({
  basePath: env,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '69caec649a4613000d81fe4c',
      'PLAID-SECRET': process.env.PLAID_SECRET || '2124a58d6d1a455cdf9a1c79c8abc0',
    },
  },
});

const plaidClient = new PlaidApi(config);

let accessToken = null;

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

app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    accessToken = response.data.access_token;
    res.json({ success: true });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  if (!accessToken) {
    return res.status(400).json({ error: 'No account connected. Please link your bank first.' });
  }
  try {
    const startDate = req.query.start || '2026-03-29';
    const endDate = req.query.end || '2026-04-04';
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 100, offset: 0 },
    });

    const spending = {
      '2026-03-29': 0, '2026-03-30': 0, '2026-03-31': 0,
      '2026-04-01': 0, '2026-04-02': 0, '2026-04-03': 0, '2026-04-04': 0
    };

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

app.get('/', (req, res) => res.json({ status: 'Shiftboard Plaid backend running', env: process.env.PLAID_ENV || 'sandbox' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT + ' env=' + (process.env.PLAID_ENV || 'sandbox')));
