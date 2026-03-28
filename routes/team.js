const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

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
  const validRole = ['admin', 'staff'].includes(role) ? role : 'staff';

  // Check if user already exists
  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  const { data, error } = await supabaseAdmin
    .from('team_members')
    .insert({
      daycare_id: req.daycareId,
      user_id: existingProfile?.id || null,
      role: validRole,
      invited_by: req.user.id,
      invited_email: email,
      status: existingProfile ? 'active' : 'invited'
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/team/:id/role — update team member role
router.put('/:id/role', requireAuth, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { role } = req.body;
  if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
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
