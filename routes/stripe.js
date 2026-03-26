const express = require('express');
const router = express.Router();

// POST /api/stripe/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  // TODO: Wire up Stripe Checkout (Day 2)
  res.status(501).json({ error: 'Not implemented yet' });
});

// POST /api/stripe/webhook
// Note: Stripe webhooks need raw body, not JSON-parsed
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // TODO: Handle Stripe webhook events (Day 2)
  res.status(501).json({ error: 'Not implemented yet' });
});

module.exports = router;
