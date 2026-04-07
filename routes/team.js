const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendTeamInvite } = require('../utils/email');

// GET /api/team — list team members
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  // Step 1: fetch team members
  const { data: members, error } = await supabaseAdmin
    .from('team_members')
    .select('*')
    .eq('daycare_id', req.daycareId)
    .neq('status', 'disabled');

  if (error) return res.status(500).json({ error: error.message });
  if (!members || !members.length) return res.json([]);

  // Step 2: fetch profiles for all user_ids that exist
  const userIds = members.map(m => m.user_id).filter(Boolean);
  let profileMap = {};
  if (userIds.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, email, first_name, last_name')
      .in('id', userIds);
    if (profiles) {
      profiles.forEach(p => { profileMap[p.id] = p; });
    }
  }

  // Step 3: merge profile data onto each member
  const result = members.map(m => ({
    ...m,
    profiles: m.user_id ? (profileMap[m.user_id] || null) : null
  }));

  res.json(result);
});

// POST /api/team/invite — invite a team member by email
router.post('/invite', requireAuth, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Admins can only invite staff — only owners can create admins
  let validRole = ['admin', 'staff'].includes(role) ? role : 'staff';
  if (req.userRole === 'admin' && validRole === 'admin') {
    return res.status(403).json({ error: 'Site Managers can only be provisioned by the account owner.' });
  }

  // Check if user already exists in profiles
  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  // Generate a secure invite token (expires in 7 days)
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('team_members')
    .insert({
      daycare_id: req.daycareId,
      user_id: existingProfile?.id || null,
      role: validRole,
      invited_by: req.user.id,
      invited_email: email,
      status: existingProfile ? 'active' : 'invited',
      invite_token: inviteToken,
      invite_expires_at: inviteExpiresAt
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Send invite email (unless user already exists)
  if (!existingProfile) {
    try {
      // Fetch inviter's name + daycare name for the email
      const [inviterRes, daycareRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('first_name, last_name').eq('id', req.user.id).single(),
        supabaseAdmin.from('daycares').select('name').eq('id', req.daycareId).single()
      ]);
      const inviterName = inviterRes.data
        ? `${inviterRes.data.first_name || ''} ${inviterRes.data.last_name || ''}`.trim() || req.user.email
        : req.user.email;
      const daycareName = daycareRes.data?.name || 'your daycare';
      const baseUrl = process.env.BASE_URL || 'https://usetailwag.co';
      const joinUrl = `${baseUrl}/join.html?token=${inviteToken}`;

      await sendTeamInvite({ to: email, inviterName, daycareName, joinUrl });
    } catch (emailErr) {
      // Email failure is non-fatal — team member record is already created
      console.error('Invite email failed:', emailErr.message);
    }
  }

  res.status(201).json({ ...data, invite_email_sent: !existingProfile });
});

// PUT /api/team/:id/role — update team member role
router.put('/:id/role', requireAuth, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { role } = req.body;
  if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  // Admins cannot promote anyone to admin
  if (req.userRole === 'admin' && role === 'admin') {
    return res.status(403).json({ error: 'Only the account owner can assign Site Manager role.' });
  }
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .update({ role })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/team/:id — remove team member
router.delete('/:id', requireAuth, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { error } = await supabaseAdmin
    .from('team_members')
    .update({ status: 'disabled' })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
