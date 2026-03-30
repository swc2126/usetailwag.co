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

  const {
    enabled,
    auto_send_review,
    review_delay_hours,
    sentiment_threshold,
    notification_email,
    followup_message
  } = req.body;

  const payload = {
    daycare_id: req.daycareId,
    updated_at: new Date().toISOString()
  };

  if (enabled !== undefined)           payload.enabled = enabled;
  if (auto_send_review !== undefined)  payload.auto_send_review = auto_send_review;
  if (review_delay_hours !== undefined) payload.review_delay_hours = Math.min(4, Math.max(1, parseInt(review_delay_hours) || 2));
  if (sentiment_threshold !== undefined) payload.sentiment_threshold = sentiment_threshold;
  if (notification_email !== undefined) payload.notification_email = notification_email;
  if (followup_message !== undefined)  payload.followup_message = followup_message;

  const { data, error } = await supabaseAdmin
    .from('sentiment_config')
    .upsert(payload, { onConflict: 'daycare_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── INBOUND SMS WEBHOOK ────────────────────────────────────────────────────
// POST /api/sms/incoming — Twilio posts here when a pet parent replies
// Must be registered with express.urlencoded middleware (see server.js)

router.post('/incoming', async (req, res) => {
  // Twilio sends form-encoded: From, To, Body, MessageSid
  const { From, To, Body, MessageSid } = req.body;

  if (!From || !Body) return res.sendStatus(200); // always 200 to Twilio

  try {
    // 1. Match To number → daycare
    const { data: twilioConfig } = await supabaseAdmin
      .from('twilio_config')
      .select('daycare_id')
      .eq('phone_number', To)
      .eq('status', 'active')
      .single();

    if (!twilioConfig) return res.sendStatus(200);
    const daycareId = twilioConfig.daycare_id;

    // 2. Match From phone → client
    const normalizedPhone = From.replace(/\D/g, '');
    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name')
      .eq('daycare_id', daycareId);

    const client = clients?.find(c => {
      const cp = (c.phone || '').replace(/\D/g, '');
      return cp && cp === normalizedPhone;
    });

    // 3. Check if sentiment is enabled for this daycare
    const { data: config } = await supabaseAdmin
      .from('sentiment_config')
      .select('*')
      .eq('daycare_id', daycareId)
      .single();

    if (!config?.enabled) {
      // Store inbound message but skip sentiment logic
      await supabaseAdmin.from('inbound_messages').insert({
        daycare_id: daycareId,
        client_id: client?.id || null,
        from_phone: From,
        body: Body,
        twilio_sid: MessageSid
      });
      return res.sendStatus(200);
    }

    // 4. Score sentiment via Claude Haiku
    let sentiment = 'neutral';
    try {
      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Rate the sentiment of this dog daycare client's reply as exactly one word.
Reply text: "${Body}"
Respond with only one word: happy, neutral, or unhappy`
        }]
      });
      const raw = aiRes.content[0].text.trim().toLowerCase();
      if (['happy', 'neutral', 'unhappy'].includes(raw)) sentiment = raw;
    } catch (aiErr) {
      console.error('Sentiment AI error:', aiErr.message);
      // Fall back to keyword detection
      const lower = Body.toLowerCase();
      if (/great|amazing|love|perfect|awesome|fantastic|wonderful|excellent|best/.test(lower)) sentiment = 'happy';
      else if (/ok|fine|good|alright|decent/.test(lower)) sentiment = 'neutral';
      else if (/bad|terrible|awful|upset|wrong|hurt|injured|problem|issue|never|disappointed/.test(lower)) sentiment = 'unhappy';
    }

    // 5. Store inbound message with sentiment
    await supabaseAdmin.from('inbound_messages').insert({
      daycare_id: daycareId,
      client_id: client?.id || null,
      from_phone: From,
      body: Body,
      sentiment,
      twilio_sid: MessageSid
    });

    // 6. Route based on sentiment
    const threshold = config.sentiment_threshold || 'unhappy_only';
    const shouldNotifyOwner =
      sentiment === 'unhappy' ||
      (sentiment === 'neutral' && threshold === 'neutral_and_unhappy');

    if (shouldNotifyOwner) {
      const notifyEmail = config.notification_email;
      if (notifyEmail) {
        const clientName = client ? `${client.first_name} ${client.last_name}` : `Unknown (${From})`;
        const sentimentLabel = sentiment === 'unhappy' ? '😟 Unhappy' : '😐 Neutral';
        await sendEmail({
          to: notifyEmail,
          subject: `TailWag: ${sentimentLabel} response from ${clientName}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f0e8;">
              <div style="background:#0F1410;border-radius:12px;padding:24px;margin-bottom:20px;">
                <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:22px;color:#F5F0E8;">TailWag</div>
                <div style="font-size:13px;color:#A8C5B0;margin-top:4px;">Client Feedback Alert</div>
              </div>
              <div style="background:#fff;border-radius:12px;padding:24px;border-left:4px solid ${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};">
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};margin-bottom:12px;">${sentimentLabel} Response</div>
                <div style="font-size:15px;font-weight:600;color:#0F1410;margin-bottom:4px;">${clientName}</div>
                <div style="font-size:13px;color:#888;margin-bottom:16px;">${From}</div>
                <div style="background:#f8f5f0;border-radius:8px;padding:16px;font-size:15px;color:#333;font-style:italic;">"${Body}"</div>
                <p style="font-size:13px;color:#888;margin-top:16px;">Respond directly to this client before asking for a Google review — their experience deserves your attention first.</p>
              </div>
              <p style="font-size:12px;color:#aaa;text-align:center;margin-top:24px;">TailWag Sentiment Routing · Sent automatically</p>
            </div>
          `,
          text: `TailWag Alert: ${sentimentLabel} response from ${clientName}\n\nThey said: "${Body}"\n\nContact: ${From}\n\nReach out before sending a review request.`
        });

        // Mark as notified
        await supabaseAdmin
          .from('inbound_messages')
          .update({ notified_owner: true })
          .eq('twilio_sid', MessageSid);
      }
    }

    // 7. Happy + auto_send_review → send Google review link
    if (sentiment === 'happy' && config.auto_send_review) {
      const { data: daycare } = await supabaseAdmin
        .from('daycares')
        .select('google_link, name, phone')
        .eq('id', daycareId)
        .single();

      if (daycare?.google_link) {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const reviewMsg = client
          ? `So glad to hear it, ${client.first_name}! If you have a moment, a quick Google review would mean the world to us 🐾 ${daycare.google_link}`
          : `So glad to hear it! If you have a moment, a Google review would mean the world to us 🐾 ${daycare.google_link}`;

        await twilio.messages.create({ from: To, to: From, body: reviewMsg });

        // Stamp review_requested_at on client record
        if (client) {
          await supabaseAdmin
            .from('clients')
            .update({ review_requested_at: new Date().toISOString() })
            .eq('id', client.id);
        }
      }
    }

  } catch (err) {
    console.error('Inbound SMS error:', err.message);
  }

  res.sendStatus(200); // always 200 to Twilio
});

module.exports = router;
