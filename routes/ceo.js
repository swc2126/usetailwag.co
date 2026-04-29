const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const PLAN_MRR = { starter: 99, growth: 179, partner: 249, founders: 109 };
const VALID_PLANS = ['starter', 'growth', 'partner', 'founders'];
const VALID_BILLING_CYCLES = ['quarterly', 'annual'];

// Phone number inventory config
const TARGET_AREA_CODES = ['469', '972', '214', '682', '817', '940'];
const INVENTORY_THRESHOLD = 3;

// Pulls all Telnyx numbers + cross-references with messaging_config to categorize
// each number into one of four buckets per area code:
//   purchased  → on Telnyx, not yet attached to messaging profile
//   on_profile → on profile, not yet on campaign (carriers haven't accepted)
//   available  → on campaign and unassigned (ready to hand to a daycare)
//   in_use     → assigned to a daycare via messaging_config
async function getNumberInventory() {
  if (!process.env.TELNYX_API_KEY) {
    throw new Error('TELNYX_API_KEY not configured');
  }

  // 1. Fetch all numbers from Telnyx
  const telnyxRes = await fetch('https://api.telnyx.com/v2/phone_numbers?page[size]=250', {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }
  });
  if (!telnyxRes.ok) {
    throw new Error(`Telnyx API error ${telnyxRes.status}`);
  }
  const telnyxData = await telnyxRes.json();
  const numbers = telnyxData.data || [];

  // 2. Find which numbers are currently assigned to a daycare
  const { data: configs } = await supabaseAdmin
    .from('messaging_config')
    .select('phone_number, daycare_id')
    .eq('status', 'active');
  const assignedSet = new Set((configs || []).map(c => c.phone_number));

  // 3. Initialize buckets for each target area code
  const emptyBucket = () => ({ purchased: 0, on_profile: 0, available: 0, in_use: 0, total: 0 });
  const byAreaCode = {};
  TARGET_AREA_CODES.forEach(ac => { byAreaCode[ac] = emptyBucket(); });
  const otherAreaCodes = {};

  // 4. Categorize each number
  for (const num of numbers) {
    const phone = num.phone_number;
    if (!phone) continue;
    const areaCode = phone.replace(/^\+1/, '').substring(0, 3);

    let bucket;
    if (TARGET_AREA_CODES.includes(areaCode)) {
      bucket = byAreaCode[areaCode];
    } else {
      if (!otherAreaCodes[areaCode]) otherAreaCodes[areaCode] = emptyBucket();
      bucket = otherAreaCodes[areaCode];
    }

    bucket.total++;
    if (assignedSet.has(phone)) {
      bucket.in_use++;
    } else if (num.messaging_campaign_id) {
      bucket.available++;
    } else if (num.messaging_profile_id) {
      bucket.on_profile++;
    } else {
      bucket.purchased++;
    }
  }

  const lowAreaCodes = TARGET_AREA_CODES.filter(ac => byAreaCode[ac].available < INVENTORY_THRESHOLD);

  // Aggregate totals across target area codes
  const totals = TARGET_AREA_CODES.reduce((acc, ac) => {
    const b = byAreaCode[ac];
    acc.purchased += b.purchased;
    acc.on_profile += b.on_profile;
    acc.available += b.available;
    acc.in_use += b.in_use;
    acc.total += b.total;
    return acc;
  }, { purchased: 0, on_profile: 0, available: 0, in_use: 0, total: 0 });

  return {
    by_area_code: byAreaCode,
    other_area_codes: otherAreaCodes,
    target_area_codes: TARGET_AREA_CODES,
    threshold: INVENTORY_THRESHOLD,
    low_area_codes: lowAreaCodes,
    totals,
    fetched_at: new Date().toISOString()
  };
}

// GET /api/ceo/overview
router.get('/overview', requireAuth, requireRole('super_admin', 'owner', 'manager'), async (req, res) => {
  try {
    console.log('[CEO] overview hit — userId:', req.user?.id, 'role:', req.userRole);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let daycares, dcError;

    if (req.userRole === 'super_admin') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .order('name'));
    } else if (req.userRole === 'owner') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .eq('owner_id', req.user.id)
        .order('name'));
    } else if (req.userRole === 'manager') {
      const { data: assignments } = await supabaseAdmin
        .from('team_members')
        .select('daycare_id')
        .eq('user_id', req.user.id)
        .eq('status', 'active');
      const ids = (assignments || []).map(a => a.daycare_id);
      if (!ids.length) {
        return res.json({
          role: req.userRole,
          totals: { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 },
          plan_distribution: { starter: 0, growth: 0, partner: 0, none: 0 },
          status_distribution: { active: 0, past_due: 0, canceled: 0, none: 0 },
          state_distribution: [],
          locations: []
        });
      }
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .in('id', ids)
        .order('name'));
    }

    console.log('[CEO] daycares found:', daycares?.length ?? 0, '| error:', dcError?.message ?? null);
    if (dcError) {
      console.error('CEO daycares query error:', dcError.message);
      return res.status(500).json({ error: dcError.message });
    }
    if (!daycares || !daycares.length) {
      return res.json({
        role: req.userRole,
        totals: { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 },
        plan_distribution: { starter: 0, growth: 0, partner: 0, none: 0 },
        status_distribution: { active: 0, past_due: 0, canceled: 0, none: 0 },
        state_distribution: [],
        locations: []
      });
    }

    // Collect all unique owner_ids to bulk-fetch profiles and subscriptions
    const ownerIds = [...new Set(daycares.map(dc => dc.owner_id).filter(Boolean))];

    const [{ data: profiles }, { data: allSubs }] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, email')
        .in('id', ownerIds),
      supabaseAdmin
        .from('subscriptions')
        .select('user_id, status, plan, billing_cycle')
        .in('user_id', ownerIds)
    ]);

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    const subMap = {};
    (allSubs || []).forEach(s => { subMap[s.user_id] = s; });

    console.log('[CEO] profiles fetched:', profiles?.length ?? 0, '| subs fetched:', allSubs?.length ?? 0);

    // Fetch per-daycare stats in parallel
    const locationStats = await Promise.all(
      daycares.map(async (dc) => {
        const [clientsRes, dogsRes, teamRes, msgs30Res, msgs7Res, lastMsgRes] = await Promise.all([
          supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('team_members').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('status', 'active'),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', thirtyDaysAgo),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', sevenDaysAgo),
          supabaseAdmin.from('messages').select('created_at').eq('daycare_id', dc.id).order('created_at', { ascending: false }).limit(1)
        ]);

        const owner = profileMap[dc.owner_id] || {};
        const sub = subMap[dc.owner_id] || null;

        const lastMsgAt = lastMsgRes.data?.[0]?.created_at || null;
        const msgs30d = msgs30Res.count || 0;
        const msgs7d = msgs7Res.count || 0;

        const daysSinceLastMsg = lastMsgAt
          ? Math.floor((now - new Date(lastMsgAt)) / (1000 * 60 * 60 * 24))
          : null;

        const createdAt = dc.created_at ? new Date(dc.created_at) : null;
        const daysSinceSignup = createdAt
          ? Math.floor((now - createdAt) / (1000 * 60 * 60 * 24))
          : 0;

        const isActiveSub = sub?.status === 'active';
        const isInactive14d = isActiveSub && (daysSinceLastMsg === null || daysSinceLastMsg >= 14);
        const isZero7d = isActiveSub && msgs7d === 0;

        const plan = (sub?.plan || '').toLowerCase();
        const mrr = PLAN_MRR[plan] || 0;

        return {
          id: dc.id,
          name: dc.name,
          street: dc.street,
          city: dc.city,
          state: dc.state,
          zip: dc.zip,
          phone: dc.phone,
          google_link: dc.google_link,
          created_at: dc.created_at,
          owner: {
            name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || 'N/A',
            email: owner.email || ''
          },
          clients: clientsRes.count || 0,
          dogs: dogsRes.count || 0,
          team_members: teamRes.count || 0,
          messages_30d: msgs30d,
          messages_7d: msgs7d,
          last_message_at: lastMsgAt,
          days_since_last_msg: daysSinceLastMsg,
          days_since_signup: daysSinceSignup,
          is_inactive_14d: isInactive14d,
          is_zero_7d: isZero7d,
          subscription: sub ? { plan: sub.plan, status: sub.status, billing_cycle: sub.billing_cycle || 'monthly' } : null,
          mrr
        };
      })
    );

    // Aggregate totals
    const new30d = daycares.filter(dc => dc.created_at && new Date(dc.created_at) >= new Date(thirtyDaysAgo)).length;
    const inactive14dCount = locationStats.filter(l => l.is_inactive_14d).length;
    const zeroUsage7dCount = locationStats.filter(l => l.is_zero_7d).length;
    const totalMrr = locationStats.reduce((acc, l) => acc + l.mrr, 0);
    const avgTenureDays = locationStats.length
      ? Math.round(locationStats.reduce((acc, l) => acc + l.days_since_signup, 0) / locationStats.length)
      : 0;

    const totals = locationStats.reduce(
      (acc, loc) => ({
        locations: acc.locations + 1,
        new_30d: new30d,
        clients: acc.clients + loc.clients,
        dogs: acc.dogs + loc.dogs,
        messages_30d: acc.messages_30d + loc.messages_30d,
        mrr: totalMrr,
        inactive_14d: inactive14dCount,
        zero_usage_7d: zeroUsage7dCount,
        avg_tenure_days: avgTenureDays
      }),
      { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 }
    );

    // Plan distribution
    const planDist = { starter: 0, growth: 0, partner: 0, none: 0 };
    locationStats.forEach(l => {
      const p = (l.subscription?.plan || '').toLowerCase();
      if (planDist.hasOwnProperty(p)) planDist[p]++;
      else planDist.none++;
    });

    // Status distribution
    const statusDist = { active: 0, past_due: 0, canceled: 0, none: 0 };
    locationStats.forEach(l => {
      const s = (l.subscription?.status || '').toLowerCase();
      if (s === 'active') statusDist.active++;
      else if (s === 'past_due') statusDist.past_due++;
      else if (s === 'canceled') statusDist.canceled++;
      else statusDist.none++;
    });

    // State distribution
    const stateMap = {};
    locationStats.forEach(l => {
      if (l.state) stateMap[l.state] = (stateMap[l.state] || 0) + 1;
    });
    const stateDist = Object.entries(stateMap)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count);

    console.log('[CEO] totals:', JSON.stringify(totals));

    res.json({
      role: req.userRole,
      totals,
      plan_distribution: planDist,
      status_distribution: statusDist,
      state_distribution: stateDist,
      locations: locationStats
    });
  } catch (err) {
    console.error('CEO overview error:', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// GET /api/ceo/available-numbers — list individual unassigned, on-campaign numbers
// Used by the onboarding form to populate the "assign phone" dropdown.
// Optional ?area_code=469 to filter.
router.get('/available-numbers', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    if (!process.env.TELNYX_API_KEY) return res.status(500).json({ error: 'TELNYX_API_KEY not configured' });

    const telnyxRes = await fetch('https://api.telnyx.com/v2/phone_numbers?page[size]=250', {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }
    });
    if (!telnyxRes.ok) return res.status(502).json({ error: `Telnyx API error ${telnyxRes.status}` });
    const telnyxData = await telnyxRes.json();
    const numbers = telnyxData.data || [];

    const { data: configs } = await supabaseAdmin
      .from('messaging_config')
      .select('phone_number')
      .eq('status', 'active');
    const assignedSet = new Set((configs || []).map(c => c.phone_number));

    const filterAreaCode = req.query.area_code;

    const available = numbers
      .filter(n => n.phone_number && n.messaging_campaign_id && !assignedSet.has(n.phone_number))
      .map(n => ({
        phone_number: n.phone_number,
        provider_id: n.id,
        area_code: n.phone_number.replace(/^\+1/, '').substring(0, 3)
      }))
      .filter(n => !filterAreaCode || n.area_code === filterAreaCode)
      .sort((a, b) => a.phone_number.localeCompare(b.phone_number));

    res.json({ available, count: available.length });
  } catch (err) {
    console.error('Available numbers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ceo/number-inventory — phone number inventory by area code
router.get('/number-inventory', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const inventory = await getNumberInventory();
    res.json(inventory);
  } catch (err) {
    console.error('Number inventory error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ceo/onboard-daycare — full daycare activation in one shot.
// Creates auth user + profile + daycare + subscription + messaging_config + sentiment_config,
// generates a magic invite link, sends invite email, and optionally sends welcome SMS.
router.post('/onboard-daycare', requireAuth, requireRole('super_admin'), async (req, res) => {
  const { sendEmail } = require('../utils/email');
  const { sendSms } = require('../utils/telnyx');
  const body = req.body || {};
  const cleanup = [];  // track resources we created so we can roll back on failure

  try {
    // ── Validate required fields ─────────────────────────────────────────────
    const dc = body.daycare || {};
    const owner = body.owner || {};
    const sub = body.subscription || {};
    const phone = body.phone || {};
    const style = body.messaging_style || {};
    const sent = body.sentiment || {};
    const tracking = body.tracking || {};

    const missing = [];
    if (!dc.name) missing.push('daycare.name');
    if (!dc.street) missing.push('daycare.street');
    if (!dc.city) missing.push('daycare.city');
    if (!dc.state) missing.push('daycare.state');
    if (!dc.zip) missing.push('daycare.zip');
    if (!dc.phone) missing.push('daycare.phone');
    if (!dc.google_link) missing.push('daycare.google_link');
    if (!owner.first_name) missing.push('owner.first_name');
    if (!owner.last_name) missing.push('owner.last_name');
    if (!owner.email) missing.push('owner.email');
    if (!owner.phone) missing.push('owner.phone');
    if (!sub.plan) missing.push('subscription.plan');
    if (!sub.billing_cycle) missing.push('subscription.billing_cycle');
    if (!phone.phone_number) missing.push('phone.phone_number');
    if (!phone.provider_id) missing.push('phone.provider_id');
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    if (!VALID_PLANS.includes(sub.plan)) return res.status(400).json({ error: `Invalid plan: ${sub.plan}` });
    if (!VALID_BILLING_CYCLES.includes(sub.billing_cycle)) return res.status(400).json({ error: `Invalid billing cycle: ${sub.billing_cycle}` });

    // ── Pre-flight: email already exists? phone already assigned? ────────────
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles').select('id').eq('email', owner.email).maybeSingle();
    if (existingProfile) return res.status(409).json({ error: `An account already exists for ${owner.email}` });

    const { data: existingPhoneAssignment } = await supabaseAdmin
      .from('messaging_config').select('daycare_id').eq('phone_number', phone.phone_number).maybeSingle();
    if (existingPhoneAssignment) return res.status(409).json({ error: `Phone ${phone.phone_number} is already assigned to another daycare` });

    // ── 1. Create Supabase auth user ─────────────────────────────────────────
    const tempPassword = require('crypto').randomBytes(24).toString('base64url');
    const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: owner.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { first_name: owner.first_name, last_name: owner.last_name }
    });
    if (authErr) return res.status(500).json({ error: `Auth user creation failed: ${authErr.message}` });
    const userId = authUser.user.id;
    cleanup.push(async () => { await supabaseAdmin.auth.admin.deleteUser(userId); });

    // ── 2. Insert profile ────────────────────────────────────────────────────
    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: userId,
      email: owner.email,
      first_name: owner.first_name,
      last_name: owner.last_name,
      phone: owner.phone
    });
    if (profileErr) throw new Error(`Profile insert failed: ${profileErr.message}`);

    // ── 3. Insert daycare ────────────────────────────────────────────────────
    const { data: daycare, error: daycareErr } = await supabaseAdmin.from('daycares').insert({
      name: dc.name,
      street: dc.street,
      city: dc.city,
      state: dc.state,
      zip: dc.zip,
      phone: dc.phone,
      website: dc.website || null,
      google_link: dc.google_link,
      time_zone: dc.time_zone || 'America/Chicago',
      owner_id: userId,
      messaging_style: {
        tone: style.tone || 'warm_playful',
        emoji: style.emoji || 'sometimes',
        personality: style.personality || null,
        phrases: style.phrases || null,
        avoid: style.avoid || null,
        signature: style.signature || null
      },
      founders_circle_member: !!tracking.founders_circle_member || sub.plan === 'founders',
      onboarded_at: tracking.onboarded_at || new Date().toISOString().split('T')[0],
      go_live_at: tracking.go_live_at || tracking.onboarded_at || new Date().toISOString().split('T')[0],
      referral_source: tracking.referral_source || null,
      internal_notes: tracking.internal_notes || null
    }).select().single();
    if (daycareErr) throw new Error(`Daycare insert failed: ${daycareErr.message}`);
    cleanup.push(async () => { await supabaseAdmin.from('daycares').delete().eq('id', daycare.id); });

    // ── 4. Insert subscription ───────────────────────────────────────────────
    const { error: subErr } = await supabaseAdmin.from('subscriptions').insert({
      user_id: userId,
      plan: sub.plan,
      billing_cycle: sub.billing_cycle,
      status: 'active'
    });
    if (subErr) throw new Error(`Subscription insert failed: ${subErr.message}`);

    // ── 5. Insert messaging_config (assign phone) ────────────────────────────
    const { error: msgErr } = await supabaseAdmin.from('messaging_config').insert({
      daycare_id: daycare.id,
      phone_number: phone.phone_number,
      provider: 'telnyx',
      provider_id: phone.provider_id,
      status: 'active'
    });
    if (msgErr) throw new Error(`Messaging config insert failed: ${msgErr.message}`);

    // ── 6. Insert sentiment_config ───────────────────────────────────────────
    const { error: sentErr } = await supabaseAdmin.from('sentiment_config').insert({
      daycare_id: daycare.id,
      enabled: true,
      auto_send_review: sent.auto_send_review !== false,
      review_delay_hours: sent.review_delay_hours ?? 2,
      sentiment_threshold: sent.sentiment_threshold || 'unhappy_only',
      notification_email: sent.notification_email || owner.email
    });
    if (sentErr) console.warn('Sentiment config insert warn:', sentErr.message);  // non-fatal

    // ── 7. Generate magic invite link ────────────────────────────────────────
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: owner.email,
      options: { redirectTo: `${process.env.BASE_URL || 'https://usetailwag.co'}/new-account?d=${daycare.id}` }
    });
    if (linkErr) console.warn('Invite link generation warn:', linkErr.message);
    const inviteUrl = linkData?.properties?.action_link || `${process.env.BASE_URL || 'https://usetailwag.co'}/new-account?d=${daycare.id}`;

    // ── 8. Send invite email ─────────────────────────────────────────────────
    const emailSubject = `Welcome to TailWag, ${owner.first_name}! Your account is ready`;
    const emailHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F0E8;font-family:Inter,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <tr><td style="background:#0F1410;padding:28px 36px;text-align:center;">
            <span style="font-weight:800;font-size:22px;color:#F5F0E8;">🐾 TailWag</span>
          </td></tr>
          <tr><td style="padding:36px;">
            <h1 style="font-size:22px;font-weight:800;color:#0F1410;margin:0 0 12px;">Welcome to TailWag, ${escapeHtml(owner.first_name)}!</h1>
            <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
              Your account for <strong>${escapeHtml(dc.name)}</strong> is ready to go. Click below to set your password and log in.
            </p>
            <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 28px;">
              Your TailWag SMS line is <strong>${formatPhone(phone.phone_number)}</strong> — pet parents will receive texts from this number.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr>
              <td style="background:#1E6B4A;border-radius:8px;">
                <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#F5F0E8;text-decoration:none;">Set Up My Account →</a>
              </td>
            </tr></table>
            <p style="font-size:12px;color:#bbb;margin:0;">Excited to have ${escapeHtml(dc.name)} with us. — Summer @ TailWag</p>
          </td></tr>
        </table>
      </td></tr></table></body></html>`;
    let emailSent = false;
    try {
      await sendEmail({ to: owner.email, subject: emailSubject, html: emailHtml });
      emailSent = true;
    } catch (e) {
      console.warn('Welcome email failed:', e.message);
    }

    // ── 9. Send welcome SMS ──────────────────────────────────────────────────
    let smsSent = false;
    if (body.send_welcome_sms) {
      try {
        const smsBody = `Hi ${owner.first_name}! Welcome to TailWag — your account is ready. Set your password and log in here: ${inviteUrl}. Excited to have ${dc.name} with us! — Summer`;
        await sendSms({ from: phone.phone_number, to: owner.phone, text: smsBody });
        smsSent = true;
      } catch (e) {
        console.warn('Welcome SMS failed:', e.message);
      }
    }

    // ── 10. Insert audit record (non-fatal — log warns on failure) ───────────
    try {
      await supabaseAdmin.from('onboarding_records').insert({
        daycare_id: daycare.id,
        daycare_name: dc.name,
        owner_email: owner.email,
        owner_name: `${owner.first_name} ${owner.last_name}`,
        owner_phone: owner.phone,
        assigned_phone: phone.phone_number,
        plan: sub.plan,
        billing_cycle: sub.billing_cycle,
        founders_circle_member: !!tracking.founders_circle_member || sub.plan === 'founders',
        referral_source: tracking.referral_source || null,
        onboarded_by: req.user.id,
        go_live_date: tracking.go_live_at || tracking.onboarded_at || new Date().toISOString().split('T')[0],
        full_payload: body,
        email_sent: emailSent,
        sms_sent: smsSent,
        invite_url: inviteUrl,
        notes: tracking.internal_notes || null
      });
    } catch (auditErr) {
      console.warn('Onboarding audit log insert failed:', auditErr.message);
    }

    res.json({
      success: true,
      daycare_id: daycare.id,
      owner_id: userId,
      assigned_phone: phone.phone_number,
      invite_url: inviteUrl,
      email_sent: emailSent,
      sms_sent: smsSent,
      copy_paste_message: `Hi ${owner.first_name}! Your TailWag account is ready. Set your password and log in here: ${inviteUrl}`
    });
  } catch (err) {
    console.error('Onboard daycare error:', err.message);
    // Roll back in reverse order
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch (e) { console.warn('Rollback step failed:', e.message); }
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ceo/onboarding-history — frozen audit log of every onboarding event
router.get('/onboarding-history', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { data, error } = await supabaseAdmin
      .from('onboarding_records')
      .select('id, daycare_id, daycare_name, owner_email, owner_name, assigned_phone, plan, billing_cycle, founders_circle_member, referral_source, onboarded_at, go_live_date, email_sent, sms_sent, notes')
      .order('onboarded_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ records: data || [], count: (data || []).length });
  } catch (err) {
    console.error('Onboarding history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatPhone(p) {
  const digits = (p || '').replace(/\D/g, '').replace(/^1/, '');
  if (digits.length !== 10) return p;
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
}

// GET /api/ceo/whoami — debug endpoint to check role
router.get('/whoami', requireAuth, async (req, res) => {
  res.json({ userId: req.user?.id, email: req.user?.email, role: req.userRole, daycareId: req.daycareId });
});

// GET /api/ceo/accounts — super_admin only
router.get('/accounts', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, first_name, last_name, phone, is_super_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const enriched = await Promise.all(profiles.map(async (p) => {
      const { data: daycares } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state')
        .eq('owner_id', p.id);
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', p.id)
        .single();
      return { ...p, daycares: daycares || [], subscription: sub || null };
    }));

    res.json({ accounts: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

module.exports = router;
module.exports.getNumberInventory = getNumberInventory;
module.exports.TARGET_AREA_CODES = TARGET_AREA_CODES;
module.exports.INVENTORY_THRESHOLD = INVENTORY_THRESHOLD;
