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

    const { plan, billing, userId, email, addReport } = req.body;
    const priceKey = `${plan}_${billing}`;
    const priceId = PRICE_MAP[priceKey];

    // Price ID for the one-time Customer Analysis Report add-on ($150)
    const REPORT_PRICE_ID = 'price_1TFavTRGw9X4KQP0g8aRitoq';

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

    // Build line items — always include the plan, optionally add the report
    const lineItems = [{ price: priceId, quantity: 1 }];
    if (addReport) {
      lineItems.push({ price: REPORT_PRICE_ID, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: `${baseUrl}/dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/signup.html?cancelled=true`,
      metadata: { userId, plan, billing, addReport: addReport ? 'true' : 'false' }
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

        // Auto-provision Twilio number for the daycare
        try {
          const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

          // Get daycare for this user
          const { data: daycare } = await supabaseAdmin
            .from('daycares')
            .select('id')
            .eq('owner_id', userId)
            .single();

          if (daycare) {
            // Check if already has a number
            const { data: existingConfig } = await supabaseAdmin
              .from('twilio_config')
              .select('id')
              .eq('daycare_id', daycare.id)
              .single();

            if (!existingConfig) {
              // Find and purchase a number
              const available = await twilioClient.availablePhoneNumbers('US').local.list({ limit: 1 });
              if (available.length > 0) {
                const purchased = await twilioClient.incomingPhoneNumbers.create({
                  phoneNumber: available[0].phoneNumber,
                  friendlyName: `TailWag - ${daycare.id}`
                });
                await supabaseAdmin.from('twilio_config').insert({
                  daycare_id: daycare.id,
                  phone_number: purchased.phoneNumber,
                  twilio_sid: purchased.sid,
                  status: 'active'
                });
                console.log(`Provisioned Twilio number ${purchased.phoneNumber} for daycare ${daycare.id}`);
              }
            }
          }
        } catch (twilioErr) {
          console.error('Auto-provision Twilio error:', twilioErr.message);
          // Don't fail the webhook — just log
        }
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
