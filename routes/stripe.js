const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Price lookup: plan + billing → Stripe price ID
// These get populated by createStripePrices() on first run
let PRICE_MAP = {};

// Create Stripe products + prices if they don't exist
async function ensureStripeProducts() {
  if (Object.keys(PRICE_MAP).length > 0) return;

  try {
    // Check for existing products
    const products = await stripe.products.list({ limit: 10 });
    const existingProduct = products.data.find(p => p.metadata?.app === 'tailwag');

    let product;
    if (existingProduct) {
      product = existingProduct;
      // Load existing prices
      const prices = await stripe.prices.list({ product: product.id, limit: 10, active: true });
      for (const price of prices.data) {
        const key = `${price.metadata.plan}_${price.metadata.billing}`;
        PRICE_MAP[key] = price.id;
      }
      if (Object.keys(PRICE_MAP).length >= 6) return; // All prices exist
    } else {
      product = await stripe.products.create({
        name: 'TailWag SMS Platform',
        metadata: { app: 'tailwag' }
      });
    }

    // Define plans: monthly price, then quarterly = monthly*3, annual = monthly*12*0.9
    const plans = {
      starter: { monthly: 189, name: 'Starter — Up to 25 dogs' },
      growth:  { monthly: 249, name: 'Growth — Up to 60 dogs' },
      pro:     { monthly: 329, name: 'Pro — 60+ dogs' }
    };

    for (const [planKey, plan] of Object.entries(plans)) {
      // Quarterly price
      const qKey = `${planKey}_quarterly`;
      if (!PRICE_MAP[qKey]) {
        const qPrice = await stripe.prices.create({
          product: product.id,
          unit_amount: plan.monthly * 3 * 100, // in cents
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 3 },
          nickname: `${plan.name} (Quarterly)`,
          metadata: { plan: planKey, billing: 'quarterly' }
        });
        PRICE_MAP[qKey] = qPrice.id;
      }

      // Annual price (10% off)
      const aKey = `${planKey}_annual`;
      if (!PRICE_MAP[aKey]) {
        const aPrice = await stripe.prices.create({
          product: product.id,
          unit_amount: Math.round(plan.monthly * 12 * 0.9) * 100, // in cents
          currency: 'usd',
          recurring: { interval: 'year' },
          nickname: `${plan.name} (Annual)`,
          metadata: { plan: planKey, billing: 'annual' }
        });
        PRICE_MAP[aKey] = aPrice.id;
      }
    }

    console.log('Stripe products/prices ready:', PRICE_MAP);
  } catch (err) {
    console.error('Error setting up Stripe products:', err.message);
  }
}

// Initialize on startup
ensureStripeProducts();

// POST /api/stripe/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  try {
    await ensureStripeProducts();

    const { plan, billing, userId, email } = req.body;
    const priceKey = `${plan}_${billing}`;
    const priceId = PRICE_MAP[priceKey];

    if (!priceId) {
      return res.status(400).json({ error: `Invalid plan/billing: ${priceKey}` });
    }

    // Create or retrieve Stripe customer
    let customerId;
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (sub?.stripe_customer_id) {
      customerId = sub.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId }
      });
      customerId = customer.id;

      await supabaseAdmin
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', userId);
    }

    const baseUrl = process.env.NODE_ENV === 'production'
      ? `https://${req.get('host')}`
      : `http://localhost:${process.env.PORT || 3000}`;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${baseUrl}/dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/signup.html?cancelled=true`,
      metadata: { userId, plan, billing }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// POST /api/stripe/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { userId, plan, billing } = session.metadata;

      if (userId) {
        await supabaseAdmin
          .from('subscriptions')
          .update({
            stripe_subscription_id: session.subscription,
            plan,
            billing_cycle: billing,
            status: 'active'
          })
          .eq('user_id', userId);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .single();

      if (sub) {
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status === 'active' ? 'active' : 'past_due',
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
          })
          .eq('user_id', sub.user_id);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'cancelled' })
        .eq('stripe_customer_id', customerId);
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
