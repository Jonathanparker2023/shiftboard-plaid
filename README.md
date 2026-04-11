# Shiftboard Plaid Backend

## Deploy to Render (free)

1. Go to github.com and create a free account if you don't have one
2. Create a new repository called "shiftboard-plaid"
3. Upload these files: index.js, package.json, render.yaml
4. Go to render.com and sign up free
5. Click "New" → "Web Service"
6. Connect your GitHub repo
7. Render auto-detects the config from render.yaml
8. Click Deploy
9. Copy your Render URL (looks like https://shiftboard-plaid.onrender.com)
10. Paste the URL into your Shiftboard app

## Endpoints
- POST /api/create-link-token  → starts Plaid Link flow
- POST /api/exchange-token     → saves your bank connection
- GET  /api/transactions       → returns weekly spending by day
