const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIG ────────────────────────────────────────────────────────────────

// GET /api/sentiment/config
router.get('/config', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { data, error } = await supabaseAdmin
    .from('sentiment_config')
    .select('*')
    .eq('daycare_id', req.daycareId)
    .single();

  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || {});
});

// PUT /api/sentiment/config
router.put('/config', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Admin only' });

  const { enabled, auto_send_review, review_delay_hours, sentiment_threshold, notification_email } = req.body;

  const payload = {
    daycare_id: req.daycareId,
    updated_at: new Date().toISOString()
  };

  if (enabled !== undefined)            payload.enabled = enabled;
  if (auto_send_review !== undefined)   payload.auto_send_review = auto_send_review;
  if (review_delay_hours !== undefined) payload.review_delay_hours = Math.min(4, Math.max(1, parseInt(review_delay_hours) || 2));
  if (sentiment_threshold !== undefined) payload.sentiment_threshold = sentiment_threshold;
  if (notification_email !== undefined) payload.notification_email = notification_email;

  const { data, error } = await supabaseAdmin
    .from('sentiment_config')
    .upsert(payload, { onConflict: 'daycare_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── SCORE SENTIMENT ON STAFF NOTES ────────────────────────────────────────
// POST /api/sentiment/score
// Called internally after sending a report card.
// Scores the staff notes, then routes: happy → queue review request, neutral/unhappy → email owner.

router.post('/score', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { notes, dog_name, owner_first_name, client_id, recipient_phone } = req.body;
  if (!notes) return res.status(400).json({ error: 'notes required' });

  // Check sentiment config
  const { data: config } = await supabaseAdmin
    .from('sentiment_config')
    .select('*')
    .eq('daycare_id', req.daycareId)
    .single();

  if (!config?.enabled) return res.json({ sentiment: null, action: 'disabled' });

  // Score sentiment via Claude Haiku on the staff notes
  let sentiment = 'neutral';
  try {
    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `A dog daycare staff member wrote these notes about a dog's visit today:

"${notes}"

Based only on these notes, rate the overall sentiment of the visit as one word.
Respond with only: happy, neutral, or unhappy`
      }]
    });
    const raw = aiRes.content[0].text.trim().toLowerCase();
    if (['happy', 'neutral', 'unhappy'].includes(raw)) sentiment = raw;
  } catch (aiErr) {
    console.error('Sentiment score AI error:', aiErr.message);
    // Keyword fallback
    const lower = notes.toLowerCase();
    if (/great|amazing|loved|perfect|fantastic|excellent|wonderful|best|thrived|enjoyed/.test(lower)) sentiment = 'happy';
    else if (/incident|hurt|injured|sick|upset|refused|wouldn't|wouldn't|struggle|difficult|concern|worried|off|tired|unusual/.test(lower)) sentiment = 'unhappy';
  }

  const threshold = config.sentiment_threshold || 'unhappy_only';
  const shouldNotifyOwner =
    sentiment === 'unhappy' ||
    (sentiment === 'neutral' && threshold === 'neutral_and_unhappy');

  // Notify owner if threshold met
  if (shouldNotifyOwner && config.notification_email) {
    const { data: daycare } = await supabaseAdmin
      .from('daycares')
      .select('name')
      .eq('id', req.daycareId)
      .single();

    const sentimentLabel = sentiment === 'unhappy' ? '⚠️ Concern flagged' : '📋 Visit noted';
    const clientLabel = owner_first_name
      ? `${owner_first_name}'s dog ${dog_name || ''}`
      : dog_name || 'a client';

    await sendEmail({
      to: config.notification_email,
      subject: `TailWag: ${sentimentLabel} — ${dog_name || 'dog'}'s visit today`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f0e8;">
          <div style="background:#0F1410;border-radius:12px;padding:24px;margin-bottom:20px;">
            <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:22px;color:#F5F0E8;">TailWag</div>
            <div style="font-size:13px;color:#A8C5B0;margin-top:4px;">Visit Flag — ${daycare?.name || 'Your Daycare'}</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:24px;border-left:4px solid ${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};">
            <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};margin-bottom:12px;">${sentimentLabel}</div>
            <div style="font-size:15px;font-weight:600;color:#0F1410;margin-bottom:12px;">Today's notes for ${clientLabel}:</div>
            <div style="background:#f8f5f0;border-radius:8px;padding:16px;font-size:15px;color:#333;font-style:italic;">"${notes}"</div>
            <p style="font-size:13px;color:#888;margin-top:16px;">A review request was <strong>not sent</strong> for this visit. You may want to follow up with this client directly.</p>
          </div>
          <p style="font-size:12px;color:#aaa;text-align:center;margin-top:24px;">TailWag Sentiment Routing · Sent automatically</p>
        </div>
      `,
      text: `TailWag Visit Flag\n\nNotes for ${clientLabel}: "${notes}"\n\nSentiment: ${sentiment}\nReview request was NOT sent.\n\nConsider following up with this client.`
    });
  }

  // Queue review request if happy and auto_send_review is on
  let reviewQueued = false;
  if (sentiment === 'happy' && config.auto_send_review && client_id && recipient_phone) {
    const { data: daycare } = await supabaseAdmin
      .from('daycares')
      .select('name, google_link')
      .eq('id', req.daycareId)
      .single();

    if (daycare?.google_link) {
      const delayHours = config.review_delay_hours || 2;
      const sendAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();
      const reviewBody = owner_first_name
        ? `So glad ${dog_name || 'your dog'} had a great day, ${owner_first_name}! If you have a moment, a quick Google review would mean the world to us 🐾 ${daycare.google_link}`
        : `So glad ${dog_name || 'your dog'} had a great day! A quick Google review would mean the world to us 🐾 ${daycare.google_link}`;

      await supabaseAdmin.from('pending_followups').insert({
        daycare_id: req.daycareId,
        client_id,
        dog_name: dog_name || null,
        owner_first_name: owner_first_name || null,
        recipient_phone,
        followup_body: reviewBody,
        send_at: sendAt
      });

      reviewQueued = true;
    }
  }

  res.json({ sentiment, action: shouldNotifyOwner ? 'owner_notified' : reviewQueued ? 'review_queued' : 'no_action' });
});

module.exports = router;
