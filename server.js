require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — must be registered before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Twilio status callback uses urlencoded
app.use('/api/sms/status', express.urlencoded({ extended: false }));

// Parse JSON bodies
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/dogs', require('./routes/dogs'));
app.use('/api/team', require('./routes/team'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/media', require('./routes/media'));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`TailWag server running on port ${PORT}`);
});
