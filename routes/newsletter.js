const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// Sync subscriber to Brevo contact list (fire and forget)
async function syncToBrevo(email, attrs = {}) {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;
  if (!apiKey) return;

  const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };

  try {
    // Step 1 — Create or update the contact with attributes (no listIds here)
    const body = { email, updateEnabled: true };
    const attributes = {};
    if (attrs.first_name)   attributes.FIRSTNAME    = attrs.first_name;
    if (attrs.last_name)    attributes.LASTNAME     = attrs.last_name;
    if (attrs.opened_month) attributes.OPENED_MONTH = attrs.opened_month;
    if (attrs.opened_year)  attributes.OPENED_YEAR  = parseInt(attrs.opened_year, 10);
    if (attrs.dogs_served)  attributes.DOGS_SERVED  = attrs.dogs_served;
    if (attrs.staff_count)  attributes.STAFF_COUNT  = attrs.staff_count;
    if (attrs.role)         attributes.ROLE         = attrs.role === 'Other' && attrs.role_other ? attrs.role_other : attrs.role;
    if (Object.keys(attributes).length) body.attributes = attributes;

    const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!contactRes.ok) {
      const err = await contactRes.json();
      if (err.code !== 'duplicate_parameter') {
        console.error('Brevo create contact error:', err);
      }
    }

    // Step 2 — Explicitly add to list via dedicated endpoint (this reliably fires the automation trigger)
    if (listId) {
      const listRes = await fetch(`https://api.brevo.com/v3/contacts/lists/${parseInt(listId, 10)}/contacts/add`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ emails: [email] })
      });
      if (!listRes.ok) {
        const err = await listRes.json();
        console.error('Brevo add-to-list error:', err);
      }
    }
  } catch (err) {
    console.error('Brevo sync fetch error:', err.message);
  }
}

// GET — redirect direct visits back to the landing page
router.get('/subscribe', (req, res) => {
  res.redirect(301, 'https://usetailwag.co/chew-on-this');
});

// CORS headers for all newsletter routes (GitHub Pages → Render)
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// POST /api/newsletter/subscribe
router.post('/subscribe', async (req, res) => {
  const { email, first_name, last_name, opened_month, opened_year, dogs_served, staff_count, role, role_other } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Build upsert record — include optional profile fields when provided
  const record = { email: normalizedEmail };
  if (opened_month) record.opened_month = opened_month;
  if (opened_year)  record.opened_year  = parseInt(opened_year, 10);
  if (dogs_served)  record.dogs_served  = dogs_served;
  if (staff_count)  record.staff_count  = staff_count;
  if (role)         record.role         = role;
  if (role_other)   record.role_other   = role_other;

  // Upsert — if already subscribed, update their profile data
  let { error } = await supabaseAdmin
    .from('newsletter_subscribers')
    .upsert(record, { onConflict: 'email', ignoreDuplicates: false });

  // If upsert failed (e.g. new columns not yet migrated), fall back to email-only upsert
  if (error) {
    console.error('Newsletter upsert error (full record):', error.message);
    const fallback = await supabaseAdmin
      .from('newsletter_subscribers')
      .upsert({ email: normalizedEmail }, { onConflict: 'email', ignoreDuplicates: true });
    if (fallback.error) {
      console.error('Newsletter subscribe error (fallback):', fallback.error);
      return res.status(500).json({ error: 'Could not subscribe. Please try again.' });
    }
    error = null;
  }

  if (error) {
    console.error('Newsletter subscribe error:', error);
    return res.status(500).json({ error: 'Could not subscribe. Please try again.' });
  }

  // Sync to Brevo contact list (fire and forget)
  // Welcome email is handled by Brevo automation triggered on contact added to list
  syncToBrevo(normalizedEmail, { first_name, last_name, opened_month, opened_year, dogs_served, staff_count, role, role_other });

  return res.json({ ok: true });
});

module.exports = router;
