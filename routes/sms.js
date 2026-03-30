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

  const { client_id, recipient_phone, body, media_url, media_type, schedule_followup, dog_name, owner_first_name } = req.body;
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
    statusCallback: `${process.env.BASE_URL || 'https://usetailwag-co.onrender.com'}/api/sms/status`
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

  // Schedule sentiment follow-up if requested and sentiment is enabled for this daycare
  if (schedule_followup && status === 'sent' && client_id) {
    try {
      const { data: sentCfg } = await supabaseAdmin
        .from('sentiment_config')
        .select('enabled, review_delay_hours, followup_message')
        .eq('daycare_id', req.daycareId)
        .single();

      if (sentCfg?.enabled) {
        const delayHours = sentCfg.review_delay_hours || 2;
        const sendAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();

        // Build follow-up message
        const daycareName = (await supabaseAdmin.from('daycares').select('name').eq('id', req.daycareId).single()).data?.name || 'us';
        const defaultMsg = dog_name
          ? `How was ${dog_name}'s visit today${owner_first_name ? `, ${owner_first_name}` : ''}? We'd love to hear your thoughts 🐾`
          : `How was your visit today? Your feedback means a lot to us 🐾`;
        const followupBody = sentCfg.followup_message
          ? sentCfg.followup_message.replace('{dog}', dog_name || 'your dog').replace('{owner}', owner_first_name || 'there').replace('{daycare}', daycareName)
          : defaultMsg;

        await supabaseAdmin.from('pending_followups').insert({
          daycare_id: req.daycareId,
          client_id,
          dog_name: dog_name || null,
          owner_first_name: owner_first_name || null,
          recipient_phone,
          message_id: logged?.id || null,
          followup_body: followupBody,
          send_at: sendAt
        });
      }
    } catch (followupErr) {
      console.error('Follow-up scheduling error:', followupErr.message);
    }
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
      statusCallback: `${process.env.BASE_URL || 'https://usetailwag-co.onrender.com'}/api/sms/status`
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
