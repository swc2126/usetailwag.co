const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/team — list team members
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('*, profiles(email, first_name, last_name)')
    .eq('daycare_id', req.daycareId)
    .neq('status', 'disabled');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
