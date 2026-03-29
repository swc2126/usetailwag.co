const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { sendEmail } = require('../utils/email');

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

  // Send welcome email (fire and forget)
  sendEmail({
    to: normalizedEmail,
    subject: 'You\'re on the list — The Pickup Line',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#F5F0E8;border-radius:12px;overflow:hidden;">
        <div style="background:#0F1410;padding:28px 32px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="background:#1E6B4A;border-radius:7px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
              <svg width="18" height="18" viewBox="0 0 56 56" fill="none"><rect width="56" height="56" rx="9" fill="#1E6B4A"/><path d="M18 34C18 28 22 22 28 20C34 22 38 28 38 34" stroke="#F5F0E8" stroke-width="3.5" stroke-linecap="round"/><circle cx="28" cy="38" r="3" fill="#C4933F"/><circle cx="20" cy="18" r="3" fill="#F5F0E8"/><circle cx="36" cy="18" r="3" fill="#F5F0E8"/><circle cx="14" cy="26" r="3" fill="#F5F0E8"/><circle cx="42" cy="26" r="3" fill="#F5F0E8"/></svg>
            </div>
            <span style="color:#F5F0E8;font-weight:800;font-size:17px;">TailWag</span>
          </div>
        </div>
        <div style="padding:32px;">
          <p style="color:#C4933F;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;">The Pickup Line</p>
          <h2 style="color:#0F1410;font-size:22px;font-weight:800;margin:0 0 16px;line-height:1.3;">You're on the list.</h2>
          <p style="color:#444;font-size:15px;line-height:1.7;margin-bottom:16px;">
            Every two weeks you'll get one short, useful email — real stories, real numbers, and practical tips from daycares we work with.
          </p>
          <p style="color:#444;font-size:15px;line-height:1.7;margin-bottom:24px;">
            No fluff. No sales pitch. Just the stuff worth reading.
          </p>
          <p style="color:#888;font-size:13px;">
            If you ever want off the list, just reply "unsubscribe" and we'll take care of it.
          </p>
          <p style="color:#888;font-size:13px;margin-top:24px;border-top:1px solid #ddd;padding-top:16px;">
            — Summer, TailWag<br>
            <a href="mailto:summer@usetailwag.com" style="color:#1E6B4A;text-decoration:none;">summer@usetailwag.com</a>
          </p>
        </div>
      </div>
    `,
    text: `You're on the list — The Pickup Line\n\nEvery two weeks: real stories, real numbers, and practical tips from daycares we work with. No fluff. No sales pitch.\n\n— Summer, TailWag\nsummer@usetailwag.com`
  }).catch(err => console.error('Welcome email error:', err));

  return res.json({ ok: true });
});

module.exports = router;
