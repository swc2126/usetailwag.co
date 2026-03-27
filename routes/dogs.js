const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/dogs — list all dogs for the daycare
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data, error } = await supabaseAdmin
    .from('dogs')
    .select('*, clients(id, first_name, last_name, phone)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/dogs/client/:clientId — dogs for a specific client
router.get('/client/:clientId', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('dogs')
    .select('*')
    .eq('client_id', req.params.clientId)
    .eq('daycare_id', req.daycareId)
    .eq('active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/dogs — create dog
router.post('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { client_id, name, breed, weight, age, medications, notes } = req.body;
  if (!client_id || !name) return res.status(400).json({ error: 'client_id and name required' });
  const { data, error } = await supabaseAdmin
    .from('dogs')
    .insert({ client_id, daycare_id: req.daycareId, name, breed, weight, age, medications, notes })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/dogs/:id — update dog
router.put('/:id', requireAuth, async (req, res) => {
  const { name, breed, weight, age, medications, notes } = req.body;
  const { data, error } = await supabaseAdmin
    .from('dogs')
    .update({ name, breed, weight, age, medications, notes })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/dogs/:id — soft delete
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('dogs')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
