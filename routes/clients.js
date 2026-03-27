const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/clients — list all clients for the daycare
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('*, dogs(id, name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true)
    .order('last_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/clients — create client
router.post('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { first_name, last_name, phone, email, notes } = req.body;
  if (!first_name || !last_name || !phone) return res.status(400).json({ error: 'first_name, last_name, phone required' });
  const { data, error } = await supabaseAdmin
    .from('clients')
    .insert({ daycare_id: req.daycareId, first_name, last_name, phone, email, notes })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/clients/:id — update client
router.put('/:id', requireAuth, async (req, res) => {
  const { first_name, last_name, phone, email, notes } = req.body;
  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ first_name, last_name, phone, email, notes })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/clients/:id — soft delete
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('clients')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
