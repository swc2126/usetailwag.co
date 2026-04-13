const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const https = require('https');

// ── Brevo: add contact to Chew on This newsletter list ──
async function addToBrevoNewsletter({ email, first_name, last_name, daycare_name }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      email,
      attributes: {
        FIRSTNAME: first_name || '',
        LASTNAME:  last_name  || '',
        COMPANY:   daycare_name || ''
      },
      listIds: [parseInt(process.env.BREVO_NEWSLETTER_LIST_ID || '7', 10)],
      updateEnabled: true
    });

    const options = {
      hostname: 'api.brevo.com',
      path: '/v3/contacts',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Brevo] Added ${email} to newsletter list`);
        } else {
          console.error(`[Brevo] Failed for ${email}: ${res.statusCode} ${data}`);
        }
        resolve(); // always resolve — non-fatal
      });
    });

    req.on('error', (err) => {
      console.error('[Brevo] Request error:', err.message);
      resolve(); // non-fatal
    });

    req.write(body);
    req.end();
  });
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, first_name, last_name, daycare_name, phone, city, state, google_link,
            opened_month, opened_year, dogs_served, staff_count, role, role_other,
            newsletter_opt_in } = req.body;

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for now
      user_metadata: { first_name, last_name }
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // Create profile
    await supabaseAdmin.from('profiles').insert({
      id: userId,
      email,
      daycare_name,
      phone
    });

    // Create daycare
    const daycareRecord = {
      owner_id: userId,
      name: daycare_name,
      address: [city, state].filter(Boolean).join(', '),
      phone
    };
    if (opened_month) daycareRecord.opened_month = opened_month;
    if (opened_year)  daycareRecord.opened_year  = parseInt(opened_year, 10);
    if (dogs_served)  daycareRecord.dogs_served  = dogs_served;
    if (staff_count)  daycareRecord.staff_count  = staff_count;
    if (role)         daycareRecord.owner_role   = role === 'Other' && role_other ? role_other : role;
    await supabaseAdmin.from('daycares').insert(daycareRecord);

    // Create inactive subscription record
    await supabaseAdmin.from('subscriptions').insert({
      user_id: userId,
      status: 'inactive'
    });

    // Add to Brevo newsletter if opted in
    if (newsletter_opt_in) {
      await addToBrevoNewsletter({ email, first_name, last_name, daycare_name });
    }

    // Sign the user in to get a session
    const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      // User created but sign-in failed — still return success
      return res.json({ success: true, userId, session: null });
    }

    res.json({
      success: true,
      userId,
      session: signInData.session
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    res.json({
      success: true,
      session: data.session,
      user: {
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata?.first_name || ''
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/me — get current user's profile + subscription
router.post('/me', async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Verify the token and get user
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Get profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // Get subscription
    const { data: subscription } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .single();

    // Get daycare
    const { data: daycare } = await supabaseAdmin
      .from('daycares')
      .select('*')
      .eq('owner_id', user.id)
      .single();

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.first_name || '',
      },
      profile,
      subscription,
      daycare
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/auth/lookup-invite?token=XXX — validate an invite token, return daycare + email (public)
router.get('/lookup-invite', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });

  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('id, invited_email, role, invite_expires_at, daycare_id, daycares(name, city, state)')
    .eq('invite_token', token)
    .eq('status', 'invited')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Invite not found or already used.' });

  if (new Date(data.invite_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This invite link has expired. Please ask your Site Manager to send a new one.' });
  }

  res.json({
    email: data.invited_email,
    role: data.role,
    daycare_name: data.daycares?.name || '',
    daycare_location: [data.daycares?.city, data.daycares?.state].filter(Boolean).join(', ')
  });
});

// POST /api/auth/join — complete registration from an invite link
router.post('/join', async (req, res) => {
  try {
    const { token, first_name, last_name, password } = req.body;
    if (!token || !first_name || !password) {
      return res.status(400).json({ error: 'token, first_name, and password are required' });
    }

    // Validate token
    const { data: member, error: memberErr } = await supabaseAdmin
      .from('team_members')
      .select('id, invited_email, role, invite_expires_at, daycare_id')
      .eq('invite_token', token)
      .eq('status', 'invited')
      .single();

    if (memberErr || !member) return res.status(404).json({ error: 'Invite not found or already used.' });
    if (new Date(member.invite_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite link has expired.' });
    }

    // Create the Supabase auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: member.invited_email,
      password,
      email_confirm: true,
      user_metadata: { first_name, last_name: last_name || '' }
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const userId = authData.user.id;

    // Create profile (location is inherited from daycare — no need to store separately)
    await supabaseAdmin.from('profiles').insert({
      id: userId,
      email: member.invited_email,
      first_name,
      last_name: last_name || ''
    });

    // Activate the team_members record
    await supabaseAdmin
      .from('team_members')
      .update({
        user_id: userId,
        status: 'active',
        invite_token: null,      // consume the token
        invite_expires_at: null
      })
      .eq('id', member.id);

    // Sign in and return session
    const { data: signInData, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
      email: member.invited_email,
      password
    });
    if (signInErr) {
      return res.json({ success: true, session: null, message: 'Account created. Please log in.' });
    }

    res.json({ success: true, session: signInData.session });
  } catch (err) {
    console.error('Join error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/me — get current user's profile + role (uses Authorization header)
// GET /api/auth/intercom-token — signed JWT for Intercom identity verification
router.get('/intercom-token', requireAuth, async (req, res) => {
  try {
    const secret = process.env.INTERCOM_SECRET;
    if (!secret) return res.status(500).json({ error: 'INTERCOM_SECRET not configured' });

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { user_id: req.user.id, email: req.user.email },
      secret,
      { expiresIn: '1h' }
    );
    res.json({ token });
  } catch (err) {
    console.error('Intercom token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email, first_name, last_name, phone, daycare_name')
      .eq('id', req.user.id)
      .single();

    const { data: daycare } = await supabaseAdmin
      .from('daycares')
      .select('id, name, phone, street, city, state, zip, google_link')
      .eq('id', req.daycareId)
      .single();

    res.json({
      user: { id: req.user.id, email: req.user.email },
      profile: profile || {},
      role: req.userRole || 'staff',
      daycare_id: req.daycareId,
      daycare: daycare || {}
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// POST /api/auth/request-access — request to join an existing daycare (public)
router.post('/request-access', async (req, res) => {
  try {
    const { daycare_name, first_name, last_name, email } = req.body;
    if (!daycare_name || !first_name || !email) {
      return res.status(400).json({ error: 'daycare_name, first_name, and email are required' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Fuzzy search: case-insensitive substring match on daycare name
    const searchTerm = daycare_name.trim().replace(/\s+/g, ' ');
    const { data: daycares, error } = await supabaseAdmin
      .from('daycares')
      .select('id, name, city, state, owner_id')
      .ilike('name', `%${searchTerm}%`)
      .limit(5);

    if (error) return res.status(500).json({ error: error.message });

    if (!daycares || daycares.length === 0) {
      return res.status(404).json({ error: 'no_match' });
    }

    const daycare = daycares[0];

    // Get owner's email
    const { data: ownerProfile } = await supabaseAdmin
      .from('profiles')
      .select('email, first_name')
      .eq('id', daycare.owner_id)
      .single();

    if (!ownerProfile?.email) {
      return res.status(404).json({ error: 'no_match' });
    }

    const { sendEmail } = require('../utils/email');
    const requesterName = [first_name, last_name].filter(Boolean).join(' ');
    const ownerGreet = ownerProfile.first_name || 'there';
    const location = [daycare.city, daycare.state].filter(Boolean).join(', ');

    await sendEmail({
      to: ownerProfile.email,
      subject: `TailWag: ${requesterName} wants to join ${daycare.name}`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f0e8;">
          <div style="background:#0F1410;border-radius:12px;padding:24px;margin-bottom:20px;text-align:center;">
            <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:800;font-size:22px;color:#F5F0E8;">🐾 TailWag</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;">
            <h2 style="font-size:20px;font-weight:800;color:#0F1410;margin:0 0 12px;">New access request</h2>
            <p style="font-size:15px;color:#444;line-height:1.7;margin:0 0 16px;">
              Hi ${ownerGreet}! <strong>${requesterName}</strong> is requesting to be added as a staff member at
              <strong>${daycare.name}</strong>${location ? ` in ${location}` : ''}.
            </p>
            <div style="background:#f8f5f0;border-radius:8px;padding:16px;margin-bottom:20px;">
              <div style="font-size:13px;color:#666;margin-bottom:4px;font-weight:600;">Their email:</div>
              <div style="font-size:15px;color:#0F1410;">${email}</div>
            </div>
            <p style="font-size:14px;color:#666;line-height:1.6;margin:0 0 24px;">
              If you know this person and want to add them, log into TailWag and go to <strong>Settings → Team</strong> to send them an invite link.
            </p>
            <div style="background:#e8f5ee;border-radius:8px;padding:14px;font-size:13px;color:#1E6B4A;border-left:3px solid #1E6B4A;">
              If you don't recognize this person, you can safely ignore this email.
            </div>
          </div>
          <p style="font-size:12px;color:#aaa;text-align:center;margin-top:20px;">TailWag · <a href="https://usetailwag.co" style="color:#1E6B4A;text-decoration:none;">usetailwag.co</a></p>
        </div>
      `,
      text: `Hi ${ownerGreet},\n\n${requesterName} (${email}) is requesting to join ${daycare.name} on TailWag.\n\nIf you know this person, log in to Settings → Team and send them an invite.\n\nIf you don't recognize them, ignore this email.`
    });

    res.json({ success: true, daycare_name: daycare.name });
  } catch (err) {
    console.error('Request access error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/auth/profile — update the current user's profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, phone } = req.body;
    if (!first_name && !last_name && !phone) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updates = {};
    if (first_name !== undefined) updates.first_name = first_name.trim();
    if (last_name !== undefined) updates.last_name = last_name.trim();
    if (phone !== undefined) updates.phone = phone.trim();

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, email, first_name, last_name, phone')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Keep auth metadata in sync
    await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      user_metadata: {
        first_name: updates.first_name ?? data.first_name,
        last_name:  updates.last_name  ?? data.last_name
      }
    });

    res.json({ success: true, profile: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
