const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/clients — list all clients for the daycare
//   ?q=...        substring search across first_name, last_name, phone, email, dog name
//   ?filter=...   one of: missing_email | active_month | no_recent_visit
//   filters and search compose (AND).
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const q = (req.query.q || '').trim();
  const filter = (req.query.filter || '').trim();

  // ── Pre-compute auxiliary id sets used by some filters/searches ──────
  let dogMatchClientIds = null;
  if (q) {
    // Strip chars that break PostgREST .or() syntax (comma, parens) and escape LIKE wildcards
const escaped = q.replace(/[,()]/g, ' ').replace(/[%_\\]/g, m => '\\' + m);
    const { data: dogMatches } = await supabaseAdmin
      .from('dogs')
      .select('client_id')
      .eq('daycare_id', req.daycareId)
      .ilike('name', `%${escaped}%`);
    dogMatchClientIds = [...new Set((dogMatches || []).map(d => d.client_id).filter(Boolean))];
  }

  let activeMonthClientIds = null;
  if (filter === 'active_month' || filter === 'no_recent_visit') {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from('messages')
      .select('client_id')
      .eq('daycare_id', req.daycareId)
      .gte('created_at', since)
      .not('client_id', 'is', null);
    activeMonthClientIds = [...new Set((recent || []).map(m => m.client_id))];
  }

  // ── Build the main clients query ─────────────────────────────────────
  let query = supabaseAdmin
    .from('clients')
    .select('*, dogs(id, name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true);

  if (q) {
    // Strip chars that break PostgREST .or() syntax (comma, parens) and escape LIKE wildcards
const escaped = q.replace(/[,()]/g, ' ').replace(/[%_\\]/g, m => '\\' + m);
    const orParts = [
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `phone.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`
    ];
    if (dogMatchClientIds && dogMatchClientIds.length) {
      orParts.push(`id.in.(${dogMatchClientIds.join(',')})`);
    }
    query = query.or(orParts.join(','));
  }

  if (filter === 'missing_email') {
    query = query.or('email.is.null,email.eq.');
  } else if (filter === 'active_month') {
    if (!activeMonthClientIds.length) return res.json([]);
    query = query.in('id', activeMonthClientIds);
  } else if (filter === 'no_recent_visit') {
    if (activeMonthClientIds.length) {
      query = query.not('id', 'in', `(${activeMonthClientIds.join(',')})`);
    }
  }

  const { data, error } = await query.order('last_name');
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

// GET /api/clients/:id — single client with dogs
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('*, dogs(id, name, breed)')
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .eq('active', true)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(data);
});

// PUT /api/clients/:id — update client
router.put('/:id', requireAuth, async (req, res) => {
  const { first_name, last_name, phone, email, notes, reminder_cadence } = req.body;
  const updates = {};
  if (first_name !== undefined) updates.first_name = first_name;
  if (last_name  !== undefined) updates.last_name  = last_name;
  if (phone      !== undefined) updates.phone      = phone;
  if (email      !== undefined) updates.email      = email;
  if (notes      !== undefined) updates.notes      = notes;
  if (reminder_cadence !== undefined) {
    if (!['per_visit', 'weekly_summary', 'none'].includes(reminder_cadence)) {
      return res.status(400).json({ error: 'reminder_cadence must be per_visit, weekly_summary, or none' });
    }
    updates.reminder_cadence = reminder_cadence;
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update(updates)
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
