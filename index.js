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
      'PLAID-SECRET': process.env.PLAID_SECRET || 'f338376a6a1dc1090da919bfa18dc6',
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

    // Use transactionsGet with retry for production
    let attempts = 0;
    let txData = null;
    while(attempts < 3) {
      try {
        const response = await plaidClient.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 100, offset: 0 },
        });
        txData = response.data;
        break;
      } catch(e) {
        // PRODUCT_NOT_READY means Plaid is still syncing - wait and retry
        if(e.response && e.response.data && e.response.data.error_code === 'PRODUCT_NOT_READY') {
          attempts++;
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw e;
        }
      }
    }

    if(!txData) {
      return res.status(503).json({ error: 'Plaid is still syncing your account. Please try again in 30 seconds.' });
    }

    const spending = {
      '2026-03-29': 0, '2026-03-30': 0, '2026-03-31': 0,
      '2026-04-01': 0, '2026-04-02': 0, '2026-04-03': 0, '2026-04-04': 0
    };

    txData.transactions.forEach(function(tx) {
      if (tx.amount > 0 && spending[tx.date] !== undefined) {
        spending[tx.date] += tx.amount;
      }
    });

    Object.keys(spending).forEach(d => {
      spending[d] = Math.round(spending[d]);
    });

    res.json({
      spending,
      transactions: txData.transactions.map(tx => ({
        date: tx.date,
        name: tx.name,
        amount: tx.amount,
        category: tx.category,
      }))
    });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.response ? JSON.stringify(err.response.data) : err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'Shiftboard Plaid backend running', env: process.env.PLAID_ENV || 'sandbox' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT + ' env=' + (process.env.PLAID_ENV || 'sandbox')));
