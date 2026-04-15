const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// Sync subscriber to Brevo contact list (fire and forget)
async function syncToBrevo(email, attrs = {}) {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_NEWSLETTER_LIST_ID || process.env.BREVO_LIST_ID;
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

// Send welcome email via Brevo transactional API (fire and forget)
async function sendBrevoWelcome(email, firstName) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return;

  const name = firstName ? firstName : 'there';

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'The TailWag Team', email: 'info@usetailwag.co' },
        to: [{ email }],
        subject: 'You\'re in — Chew on This 🐾',
        htmlContent: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#F5F0E8;border-radius:12px;overflow:hidden;">
            <div style="background:#0F1410;padding:28px 32px;">
              <span style="color:#F5F0E8;font-weight:800;font-size:20px;">🐾 TailWag</span>
            </div>
            <div style="padding:32px;">
              <p style="color:#C4933F;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;">Chew on This · Bi-monthly newsletter</p>
              <h2 style="color:#0F1410;font-size:22px;font-weight:800;margin:0 0 16px;line-height:1.3;">Hey ${name}, you're on the list. 🐾</h2>
              <p style="color:#444;font-size:15px;line-height:1.7;margin-bottom:16px;">
                Every two weeks you'll get one short, useful email — real stories, real numbers, and practical tips from independent dog daycares doing the work.
              </p>
              <p style="color:#444;font-size:15px;line-height:1.7;margin-bottom:24px;">
                No fluff. No sales pitch. Just the stuff worth reading over your morning coffee.
              </p>
              <p style="color:#888;font-size:13px;">
                If you ever want off the list, just reply "unsubscribe" and we'll take care of it right away.
              </p>
              <p style="color:#888;font-size:13px;margin-top:24px;border-top:1px solid #ddd;padding-top:16px;">
                — The TailWag Team<br>
                <a href="mailto:info@usetailwag.co" style="color:#1E6B4A;text-decoration:none;">info@usetailwag.co</a>
              </p>
            </div>
          </div>
        `
      })
    });
    if (!res.ok) {
      const err = await res.json();
      console.error('Brevo welcome email error:', err);
    }
  } catch (err) {
    console.error('Brevo welcome email fetch error:', err.message);
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

  // Sync to Brevo contact list + send welcome email (fire and forget)
  syncToBrevo(normalizedEmail, { first_name, last_name, opened_month, opened_year, dogs_served, staff_count, role, role_other });
  sendBrevoWelcome(normalizedEmail, first_name);

  return res.json({ ok: true });
});

module.exports = router;
