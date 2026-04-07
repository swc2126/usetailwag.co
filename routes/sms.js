const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const multer = require('multer');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

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

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

// Helper: get Twilio number for daycare
async function getTwilioNumber(daycareId) {
  const { data } = await supabaseAdmin
    .from('twilio_config')
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

  const fromNumber = await getTwilioNumber(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No Twilio number assigned. Contact support.' });

  const messageParams = {
    from: fromNumber,
    to: recipient_phone,
    body,
    statusCallback: `${process.env.BASE_URL || 'https://usetailwag.co'}/api/sms/status`
  };
  if (media_url) messageParams.mediaUrl = [media_url];

  let twilioSid, status;
  try {
    const msg = await twilioClient.messages.create(messageParams);
    twilioSid = msg.sid;
    status = 'sent';
  } catch (err) {
    console.error('Twilio send error:', err.message);
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
      twilio_sid: twilioSid || null,
      status
    })
    .select()
    .single();

  if (logError) console.error('Message log error:', logError.message);

  // Run sentiment scoring on staff notes if provided (fire and forget — non-blocking)
  if (staff_notes && status === 'sent' && client_id) {
    setImmediate(async () => {
      try {
        const { supabaseAdmin: sb } = require('../config/supabase');
        const sentimentRoute = require('./sentiment');
        // Call the score logic directly by importing shared helper
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

  if (status === 'failed') return res.status(502).json({ error: 'Message failed to send via Twilio.' });
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

  const fromNumber = await getTwilioNumber(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No Twilio number assigned.' });

  const results = { sent: 0, failed: 0, messages: [] };

  for (const recipient of recipients) {
    const messageParams = {
      from: fromNumber,
      to: recipient.phone,
      body,
      statusCallback: `${process.env.BASE_URL || 'https://usetailwag.co'}/api/sms/status`
    };
    if (media_url) messageParams.mediaUrl = [media_url];

    let twilioSid, status;
    try {
      const msg = await twilioClient.messages.create(messageParams);
      twilioSid = msg.sid;
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
      twilio_sid: twilioSid || null,
      status,
      is_bulk: true
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

// GET /api/sms/number — return assigned Twilio number for this daycare
router.get('/number', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const number = await getTwilioNumber(req.daycareId);
  res.json({ phone_number: number || null });
});

// POST /api/sms/status — Twilio status callback (no auth — Twilio posts here)
router.post('/status', express.urlencoded({ extended: false }), async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  if (MessageSid && MessageStatus) {
    await supabaseAdmin
      .from('messages')
      .update({ status: MessageStatus })
      .eq('twilio_sid', MessageSid);
  }
  res.sendStatus(200);
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

// POST /api/sms/provision — provision a Twilio number for a daycare
router.post('/provision', requireAuth, async (req, res) => {
  if (req.userRole !== 'owner') return res.status(403).json({ error: 'Only owners can provision numbers' });
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  // Check if already has a number
  const existing = await getTwilioNumber(req.daycareId);
  if (existing) return res.status(400).json({ error: 'Daycare already has a Twilio number', number: existing });

  const { areaCode } = req.body;
  try {
    // Search for available numbers
    const searchParams = { limit: 1 };
    if (areaCode) searchParams.areaCode = areaCode;

    const available = await twilioClient.availablePhoneNumbers('US').local.list(searchParams);
    if (!available.length) return res.status(404).json({ error: 'No numbers available in that area code.' });

    // Purchase the number
    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      friendlyName: `TailWag - ${req.daycareId}`
    });

    // Save to DB
    await supabaseAdmin.from('twilio_config').upsert({
      daycare_id: req.daycareId,
      phone_number: purchased.phoneNumber,
      twilio_sid: purchased.sid,
      status: 'active'
    });

    res.json({ success: true, phone_number: purchased.phoneNumber });
  } catch (err) {
    console.error('Provision error:', err.message);
    res.status(500).json({ error: 'Failed to provision number: ' + err.message });
  }
});

module.exports = router;
