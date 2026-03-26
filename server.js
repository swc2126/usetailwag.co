require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — must be registered before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Parse JSON bodies (for all other API routes)
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stripe', require('./routes/stripe'));

// Serve index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`TailWag server running on port ${PORT}`);
});
