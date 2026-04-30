const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendSms, verifyWebhook, purchaseLocalNumber } = require('../utils/telnyx');

// Multer: store in memory for Supabase upload (5MB max, images only)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  }
});

// Plan limits
const MESSAGE_LIMITS = { starter: 500, growth: 1500, pro: 5000 };
const MMS_PLANS = ['growth', 'pro'];

// Helper: get monthly usage count for a daycare
async function getMonthlyUsage(daycareId) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('daycare_id', daycareId)
    .gte('created_at', start.toISOString());
  return count || 0;
}

// Helper: get daycare plan
async function getDaycarePlan(daycareId) {
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('plan')
    .eq('user_id', (
      await supabaseAdmin.from('daycares').select('owner_id').eq('id', daycareId).single()
    ).data?.owner_id)
    .eq('status', 'active')
    .single();
  return data?.plan || 'starter';
}

// Helper: get the daycare's assigned phone number
async function getDaycareNumber(daycareId) {
  const { data } = await supabaseAdmin
    .from('messaging_config')
    .select('phone_number')
    .eq('daycare_id', daycareId)
    .eq('status', 'active')
    .single();
  return data?.phone_number;
}

// POST /api/sms/send — send a single SMS or MMS
router.post('/send', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { client_id, recipient_phone, body, media_url, media_type, staff_notes, dog_name, owner_first_name } = req.body;
  if (!recipient_phone || !body) return res.status(400).json({ error: 'recipient_phone and body required' });

  const plan = await getDaycarePlan(req.daycareId);
  const usage = await getMonthlyUsage(req.daycareId);
  const limit = MESSAGE_LIMITS[plan] || 500;

  if (usage >= limit) {
    return res.status(429).json({ error: `Monthly message limit reached (${limit}). Upgrade your plan to send more.` });
  }

  // MMS only for Growth/Pro
  if (media_url && !MMS_PLANS.includes(plan)) {
    return res.status(403).json({ error: 'Image/video messaging requires Growth or Pro plan.' });
  }

  const fromNumber = await getDaycareNumber(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No phone number assigned. Contact support.' });

  let providerMessageId, status;
  try {
    const sendRes = await sendSms({
      from: fromNumber,
      to: recipient_phone,
      text: body,
      mediaUrls: media_url ? [media_url] : undefined
    });
    providerMessageId = sendRes.id;
    status = 'sent';
  } catch (err) {
    console.error('Telnyx send error:', err.message);
    status = 'failed';
  }

  // Log message
  const { data: logged, error: logError } = await supabaseAdmin
    .from('messages')
    .insert({
      daycare_id: req.daycareId,
      client_id: client_id || null,
      sender_id: req.user.id,
      recipient_phone,
      body,
      media_url: media_url || null,
      media_type: media_type || 'none',
      provider_message_id: providerMessageId || null,
      status,
      message_type: staff_notes ? 'report_card' : 'custom'
    })
    .select()
    .single();

  if (logError) console.error('Message log error:', logError.message);

  // Run sentiment scoring on staff notes if provided (fire and forget — non-blocking)
  if (staff_notes && status === 'sent' && client_id) {
    setImmediate(async () => {
      try {
        const { supabaseAdmin: sb } = require('../config/supabase');
        const Anthropic = require('@anthropic-ai/sdk');
        const { sendEmail } = require('../utils/email');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const { data: config } = await sb.from('sentiment_config').select('*').eq('daycare_id', req.daycareId).single();
        if (!config?.enabled) return;

        let sentiment = 'neutral';
        try {
          const aiRes = await anthropic.messages.create({
            model: 'claude-haiku-4-5', max_tokens: 10,
            messages: [{ role: 'user', content: `A dog daycare staff member wrote these notes about a dog's visit:\n\n"${staff_notes}"\n\nRate the overall visit sentiment as one word. Respond with only: happy, neutral, or unhappy` }]
          });
          const raw = aiRes.content[0].text.trim().toLowerCase();
          if (['happy', 'neutral', 'unhappy'].includes(raw)) sentiment = raw;
        } catch {
          const l = staff_notes.toLowerCase();
          if (/great|amazing|loved|perfect|fantastic|excellent|wonderful|thrived|enjoyed/.test(l)) sentiment = 'happy';
          else if (/incident|hurt|injured|sick|upset|refused|struggle|difficult|concern|worried|off today/.test(l)) sentiment = 'unhappy';
        }

        const threshold = config.sentiment_threshold || 'unhappy_only';
        const shouldNotify = sentiment === 'unhappy' || (sentiment === 'neutral' && threshold === 'neutral_and_unhappy');

        if (shouldNotify && config.notification_email) {
          const { data: dc } = await sb.from('daycares').select('name').eq('id', req.daycareId).single();
          const label = sentiment === 'unhappy' ? '⚠️ Concern flagged' : '📋 Visit noted';
          await sendEmail({
            to: config.notification_email,
            subject: `TailWag: ${label} — ${dog_name || 'dog'}'s visit today`,
            html: `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f0e8;"><div style="background:#0F1410;border-radius:12px;padding:24px;margin-bottom:20px;"><div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:22px;color:#F5F0E8;">TailWag</div><div style="font-size:13px;color:#A8C5B0;margin-top:4px;">Visit Flag — ${dc?.name || 'Your Daycare'}</div></div><div style="background:#fff;border-radius:12px;padding:24px;border-left:4px solid ${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};"><div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${sentiment === 'unhappy' ? '#e74c3c' : '#C4933F'};margin-bottom:12px;">${label}</div><div style="font-size:15px;font-weight:600;color:#0F1410;margin-bottom:12px;">Today's notes for ${owner_first_name ? owner_first_name + "'s " : ''}${dog_name || 'dog'}:</div><div style="background:#f8f5f0;border-radius:8px;padding:16px;font-size:15px;color:#333;font-style:italic;">"${staff_notes}"</div><p style="font-size:13px;color:#888;margin-top:16px;">A review request was <strong>not sent</strong> for this visit.</p></div></div>`,
            text: `TailWag Visit Flag\n\nNotes for ${dog_name || 'dog'}: "${staff_notes}"\n\nSentiment: ${sentiment}\nReview request was NOT sent.`
          });
        }

        if (sentiment === 'happy' && config.auto_send_review && recipient_phone) {
          const { data: dc } = await sb.from('daycares').select('name, google_link').eq('id', req.daycareId).single();
          if (dc?.google_link) {
            const delayHours = config.review_delay_hours || 2;
            const sendAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();
            const reviewBody = owner_first_name
              ? `So glad ${dog_name || 'your dog'} had a great day, ${owner_first_name}! A quick Google review would mean the world to us 🐾 ${dc.google_link}`
              : `So glad ${dog_name || 'your dog'} had a great day! A quick Google review would mean the world to us 🐾 ${dc.google_link}`;
            await sb.from('pending_followups').insert({
              daycare_id: req.daycareId, client_id,
              dog_name: dog_name || null, owner_first_name: owner_first_name || null,
              recipient_phone, followup_body: reviewBody, send_at: sendAt
            });
          }
        }
      } catch (err) {
        console.error('Sentiment scoring error:', err.message);
      }
    });
  }

  if (status === 'failed') return res.status(502).json({ error: 'Message failed to send.' });
  res.json({ success: true, message: logged, usage: usage + 1, limit });
});

// POST /api/sms/bulk — send to multiple recipients
router.post('/bulk', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { recipients, body, media_url, media_type } = req.body;
  if (!recipients?.length || !body) return res.status(400).json({ error: 'recipients array and body required' });

  const plan = await getDaycarePlan(req.daycareId);
  const usage = await getMonthlyUsage(req.daycareId);
  const limit = MESSAGE_LIMITS[plan] || 500;

  if (usage + recipients.length > limit) {
    return res.status(429).json({
      error: `Sending ${recipients.length} messages would exceed your monthly limit of ${limit}. You have ${limit - usage} remaining.`
    });
  }

  if (media_url && !MMS_PLANS.includes(plan)) {
    return res.status(403).json({ error: 'Image/video messaging requires Growth or Pro plan.' });
  }

  const fromNumber = await getDaycareNumber(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No phone number assigned.' });

  const results = { sent: 0, failed: 0, messages: [] };

  for (const recipient of recipients) {
    let providerMessageId, status;
    try {
      const sendRes = await sendSms({
        from: fromNumber,
        to: recipient.phone,
        text: body,
        mediaUrls: media_url ? [media_url] : undefined
      });
      providerMessageId = sendRes.id;
      status = 'sent';
      results.sent++;
    } catch (err) {
      status = 'failed';
      results.failed++;
    }

    await supabaseAdmin.from('messages').insert({
      daycare_id: req.daycareId,
      client_id: recipient.client_id || null,
      sender_id: req.user.id,
      recipient_phone: recipient.phone,
      body,
      media_url: media_url || null,
      media_type: media_type || 'none',
      provider_message_id: providerMessageId || null,
      status,
      is_bulk: true,
      message_type: 'bulk'
    });
  }

  res.json({ success: true, ...results, usage: usage + results.sent, limit });
});

// GET /api/sms/thread/:clientId — full conversation thread (outbound + inbound) for a client
router.get('/thread/:clientId', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { clientId } = req.params;

  const [{ data: outbound }, { data: inbound }] = await Promise.all([
    supabaseAdmin
      .from('messages')
      .select('id, body, media_url, created_at, status')
      .eq('daycare_id', req.daycareId)
      .eq('client_id', clientId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('inbound_messages')
      .select('id, body, received_at, read')
      .eq('daycare_id', req.daycareId)
      .eq('client_id', clientId)
      .order('received_at', { ascending: true })
  ]);

  const thread = [
    ...(outbound || []).map(m => ({ ...m, direction: 'out', ts: m.created_at })),
    ...(inbound || []).map(m => ({ ...m, direction: 'in', ts: m.received_at }))
  ].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  res.json(thread);
});

// POST /api/sms/thread/:clientId/read — mark all inbound messages for a client as read
router.post('/thread/:clientId/read', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  await supabaseAdmin
    .from('inbound_messages')
    .update({ read: true })
    .eq('daycare_id', req.daycareId)
    .eq('client_id', req.params.clientId)
    .eq('read', false);
  res.json({ ok: true });
});

// GET /api/sms/unread — unread inbound message counts per client_id
router.get('/unread', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data } = await supabaseAdmin
    .from('inbound_messages')
    .select('client_id')
    .eq('daycare_id', req.daycareId)
    .eq('read', false);

  const counts = {};
  (data || []).forEach(m => {
    if (m.client_id) counts[m.client_id] = (counts[m.client_id] || 0) + 1;
  });
  res.json(counts);
});

// GET /api/sms/history — message history for the daycare
router.get('/history', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*, clients(first_name, last_name), profiles(email)')
    .eq('daycare_id', req.daycareId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/sms/usage — monthly usage stats
router.get('/usage', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const plan = await getDaycarePlan(req.daycareId);
  const usage = await getMonthlyUsage(req.daycareId);
  const limit = MESSAGE_LIMITS[plan] || 500;
  res.json({ usage, limit, plan, remaining: limit - usage });
});

// GET /api/sms/number — return assigned number for this daycare
router.get('/number', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const number = await getDaycareNumber(req.daycareId);
  res.json({ phone_number: number || null });
});

// POST /api/sms/upload-media — upload image to Supabase Storage, return public URL
// Used to get a mediaUrl before calling /send or /bulk
router.post('/upload-media', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  // MMS only for Growth/Pro
  const plan = await getDaycarePlan(req.daycareId);
  if (!MMS_PLANS.includes(plan)) {
    return res.status(403).json({ error: 'Image messaging requires Growth or Pro plan.' });
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const ext = req.file.mimetype.split('/')[1] || 'jpg';
  const filename = `${req.daycareId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabaseAdmin
    .storage
    .from('message-media')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (uploadError) {
    console.error('Storage upload error:', uploadError.message);
    return res.status(500).json({ error: 'Upload failed: ' + uploadError.message });
  }

  const { data: urlData } = supabaseAdmin
    .storage
    .from('message-media')
    .getPublicUrl(filename);

  res.json({ url: urlData.publicUrl, filename });
});

// POST /api/sms/provision — provision a Telnyx number for a daycare
router.post('/provision', requireAuth, async (req, res) => {
  if (req.userRole !== 'owner') return res.status(403).json({ error: 'Only owners can provision numbers' });
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const existing = await getDaycareNumber(req.daycareId);
  if (existing) return res.status(400).json({ error: 'Daycare already has a number', number: existing });

  const { areaCode } = req.body;
  try {
    const { phone_number, provider_id } = await purchaseLocalNumber({
      areaCode,
      label: `TailWag - ${req.daycareId}`
    });

    await supabaseAdmin.from('messaging_config').upsert({
      daycare_id: req.daycareId,
      phone_number,
      provider_id,
      provider: 'telnyx',
      status: 'active'
    });

    res.json({ success: true, phone_number });
  } catch (err) {
    console.error('Provision error:', err.message);
    if (err.code === 'NO_NUMBERS') return res.status(404).json({ error: err.message });
    res.status(500).json({ error: 'Failed to provision number: ' + err.message });
  }
});

// ─── TELNYX WEBHOOKS ───────────────────────────────────────────────────────────
// These routes expect raw body (registered in server.js before express.json()).

// POST /api/sms/telnyx/status — delivery receipts
router.post('/telnyx/status', async (req, res) => {
  let event;
  try {
    event = verifyWebhook(
      req.body,
      req.header('telnyx-signature-ed25519'),
      req.header('telnyx-timestamp')
    );
  } catch (err) {
    console.error('Telnyx status signature failed:', err.message);
    return res.sendStatus(400);
  }

  const eventType = event?.data?.event_type;
  const payload = event?.data?.payload;
  if (!payload?.id) return res.sendStatus(200);

  // Map Telnyx event types to our internal status strings
  const statusMap = {
    'message.sent': 'sent',
    'message.finalized': payload?.to?.[0]?.status === 'delivered' ? 'delivered' : 'sent',
    'message.failed': 'failed'
  };
  const status = statusMap[eventType];
  if (!status) return res.sendStatus(200);

  await supabaseAdmin
    .from('messages')
    .update({ status })
    .eq('provider_message_id', payload.id);

  res.sendStatus(200);
});

// POST /api/sms/telnyx/inbound — Telnyx posts ALL message events here
// (inbound replies + outbound delivery receipts). Dispatches on event_type.
router.post('/telnyx/inbound', async (req, res) => {
  let event;
  try {
    event = verifyWebhook(
      req.body,
      req.header('telnyx-signature-ed25519'),
      req.header('telnyx-timestamp')
    );
  } catch (err) {
    console.error('Telnyx inbound signature failed:', err.message);
    return res.sendStatus(400);
  }

  const eventType = event?.data?.event_type;
  const payload = event?.data?.payload;

  // Outbound delivery status updates
  if (['message.sent', 'message.finalized', 'message.failed'].includes(eventType)) {
    if (!payload?.id) return res.sendStatus(200);
    const statusMap = {
      'message.sent': 'sent',
      'message.finalized': payload?.to?.[0]?.status === 'delivered' ? 'delivered' : 'sent',
      'message.failed': 'failed'
    };
    const status = statusMap[eventType];
    if (status) {
      await supabaseAdmin
        .from('messages')
        .update({ status })
        .eq('provider_message_id', payload.id);
    }
    return res.sendStatus(200);
  }

  // Anything other than an actual inbound message — ack and move on
  if (eventType !== 'message.received') return res.sendStatus(200);
  const from = payload?.from?.phone_number;
  const to = payload?.to?.[0]?.phone_number;
  const body = payload?.text || '';
  const messageId = payload?.id;
  if (!from || !to) return res.sendStatus(200);

  // Find the daycare that owns the receiving number
  const { data: config } = await supabaseAdmin
    .from('messaging_config')
    .select('daycare_id')
    .eq('phone_number', to)
    .eq('status', 'active')
    .single();
  if (!config) return res.sendStatus(200);

  // Find the client by phone number
  const phone = from.replace(/\s/g, '');
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, first_name')
    .eq('daycare_id', config.daycare_id)
    .eq('phone', phone)
    .eq('active', true)
    .single();

  // Always save inbound message to history
  await supabaseAdmin.from('inbound_messages').insert({
    daycare_id: config.daycare_id,
    client_id: client?.id || null,
    from_number: from,
    to_number: to,
    body,
    provider_message_id: messageId || null,
    read: false,
    received_at: new Date().toISOString()
  });

  // Process YES/NO for appointment confirmation (always-on, regardless of messaging_mode)
  const reply = body.trim().toUpperCase();
  const isYesNo = ['YES', 'NO', 'Y', 'N'].includes(reply);

  // STOP/HELP keywords are handled by Telnyx itself — never auto-reply to those
  const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'HELP', 'INFO'];
  const isStopKeyword = STOP_KEYWORDS.includes(reply);

  if (!isYesNo) {
    // Not a YES/NO confirmation — handle based on the daycare's messaging mode.
    if (isStopKeyword) return res.sendStatus(200);

    const { data: dc } = await supabaseAdmin
      .from('daycares')
      .select('messaging_mode, auto_reply_text, phone')
      .eq('id', config.daycare_id)
      .single();

    if (dc?.messaging_mode !== 'one_way') return res.sendStatus(200);

    // Rate limit: skip if we already auto-replied to this number in the last hour
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from('messages')
      .select('id')
      .eq('daycare_id', config.daycare_id)
      .eq('recipient_phone', from)
      .eq('message_type', 'auto_reply')
      .gte('created_at', oneHourAgo)
      .limit(1);
    if (recent && recent.length > 0) return res.sendStatus(200);

    const defaultReply = `Thanks for your message! We don't actively monitor texts at this number${dc.phone ? ' — please call us at ' + dc.phone : ''}. 🐾`;
    const autoText = (dc.auto_reply_text || '').trim() || defaultReply;

    let providerId = null, sendStatus = 'failed';
    try {
      const sendRes = await sendSms({ from: to, to: from, text: autoText });
      providerId = sendRes?.id || null;
      sendStatus = 'sent';
    } catch (err) {
      console.error('Auto-reply SMS error:', err.message);
    }

    await supabaseAdmin.from('messages').insert({
      daycare_id: config.daycare_id,
      client_id: client?.id || null,
      sender_id: null,
      recipient_phone: from,
      body: autoText,
      provider_message_id: providerId,
      status: sendStatus,
      message_type: 'auto_reply'
    });

    return res.sendStatus(200);
  }

  if (!client) return res.sendStatus(200);

  const isConfirm = reply === 'YES' || reply === 'Y';

  // Find the most recent pending appointment with a reminder sent
  const { data: appt } = await supabaseAdmin
    .from('appointments')
    .select('id, appointment_date, dogs(name)')
    .eq('daycare_id', config.daycare_id)
    .eq('client_id', client.id)
    .eq('status', 'pending')
    .not('reminder_sent_at', 'is', null)
    .gte('appointment_date', new Date().toISOString().split('T')[0])
    .order('appointment_date', { ascending: true })
    .limit(1)
    .single();

  if (!appt) return res.sendStatus(200);

  const newStatus = isConfirm ? 'confirmed' : 'cancelled';
  await supabaseAdmin
    .from('appointments')
    .update({ status: newStatus, confirmed_at: new Date().toISOString() })
    .eq('id', appt.id);

  // Send acknowledgement
  const { data: daycare } = await supabaseAdmin
    .from('daycares')
    .select('name')
    .eq('id', config.daycare_id)
    .single();

  const dogName = appt.dogs?.name || 'your pup';
  const apptDate = new Date(appt.appointment_date + 'T12:00:00');
  const dayStr = apptDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const ackBody = isConfirm
    ? `Got it, ${client.first_name}! We've confirmed ${dogName} for ${dayStr}. See you then! 🐾`
    : `No problem, ${client.first_name}! We've cancelled ${dogName}'s appointment on ${dayStr}. See you next time!`;

  try {
    await sendSms({ from: to, to: from, text: ackBody });
  } catch (err) {
    console.error('Ack SMS error:', err.message);
  }

  res.sendStatus(200);
});

module.exports = router;
