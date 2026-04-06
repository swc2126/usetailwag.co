const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { sendEmail } = require('../utils/email');

// Sync subscriber to Brevo contact list (fire and forget)
async function syncToBrevo(email) {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID; // numeric list ID from Brevo dashboard
  if (!apiKey) return;

  try {
    const body = { email, updateEnabled: true };
    if (listId) body.listIds = [parseInt(listId, 10)];

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json();
      // 400 with "Contact already exist" is fine — Brevo returns this for existing contacts
      if (err.code !== 'duplicate_parameter') {
        console.error('Brevo sync error:', err);
      }
    }
  } catch (err) {
    console.error('Brevo sync fetch error:', err.message);
  }
}

// POST /api/newsletter/subscribe
router.post('/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Upsert — if already subscribed, return success silently
  const { error } = await supabaseAdmin
    .from('newsletter_subscribers')
    .upsert({ email: normalizedEmail }, { onConflict: 'email', ignoreDuplicates: true });

  if (error) {
    console.error('Newsletter subscribe error:', error);
    return res.status(500).json({ error: 'Could not subscribe. Please try again.' });
  }

  // Sync to Brevo contact list (fire and forget)
  syncToBrevo(normalizedEmail);

  // Send welcome email (fire and forget)
  sendEmail({
    to: normalizedEmail,
    subject: 'You\'re in — Chew on This 🐾',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#F5F0E8;border-radius:12px;overflow:hidden;">
        <div style="background:#0F1410;padding:28px 32px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <svg width="30" height="30" viewBox="0 0 56 56" fill="none"><rect width="56" height="56" rx="9" fill="#1E6B4A"/><path d="M11 50 C5 30,23 4,41 4 C49 4,51 18,45 26" stroke="#F5F0E8" stroke-width="6" stroke-linecap="round" fill="none"/><circle cx="45" cy="26" r="3.5" fill="#F5F0E8"/></svg>
            <span style="color:#F5F0E8;font-weight:800;font-size:17px;">TailWag</span>
          </div>
        </div>
        <div style="padding:32px;">
          <p style="color:#C4933F;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;">Chew on This · Bi-monthly newsletter</p>
          <h2 style="color:#0F1410;font-size:22px;font-weight:800;margin:0 0 16px;line-height:1.3;">You're on the list. 🐾</h2>
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
            — Summer, TailWag<br>
            <a href="mailto:summer@usetailwag.com" style="color:#1E6B4A;text-decoration:none;">summer@usetailwag.com</a>
          </p>
        </div>
      </div>
    `,
    text: `You're in — Chew on This 🐾\n\nEvery two weeks: real stories, real numbers, and practical tips from independent dog daycares doing the work. No fluff. No sales pitch.\n\n— Summer, TailWag\nsummer@usetailwag.com`
  }).catch(err => console.error('Welcome email error:', err));

  return res.json({ ok: true });
});

module.exports = router;
