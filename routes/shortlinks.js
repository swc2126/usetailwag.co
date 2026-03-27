const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// Generate a random 6-char alphanumeric code
function generateCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// POST /api/shortlinks — create a short link
router.post('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { original_url, label } = req.body;
  if (!original_url) return res.status(400).json({ error: 'original_url required' });

  // Validate it's a real URL
  try { new URL(original_url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  // Check if this URL already has a short link for this daycare
  const { data: existing } = await supabaseAdmin
    .from('short_links')
    .select('code')
    .eq('daycare_id', req.daycareId)
    .eq('original_url', original_url)
    .single();

  if (existing) {
    const baseUrl = process.env.NODE_ENV === 'production'
      ? 'https://usetailwag.co'
      : `http://localhost:${process.env.PORT || 3000}`;
    return res.json({ code: existing.code, short_url: `${baseUrl}/r/${existing.code}` });
  }

  // Generate unique code
  let code, attempts = 0;
  while (attempts < 10) {
    code = generateCode();
    const { data: collision } = await supabaseAdmin
      .from('short_links')
      .select('id')
      .eq('code', code)
      .single();
    if (!collision) break;
    attempts++;
  }

  const { data, error } = await supabaseAdmin
    .from('short_links')
    .insert({ daycare_id: req.daycareId, code, original_url, label: label || null, clicks: 0 })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://usetailwag.co'
    : `http://localhost:${process.env.PORT || 3000}`;

  res.status(201).json({ code: data.code, short_url: `${baseUrl}/r/${data.code}` });
});

// GET /api/shortlinks — list short links for this daycare
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data, error } = await supabaseAdmin
    .from('short_links')
    .select('*')
    .eq('daycare_id', req.daycareId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/shortlinks/:code
router.delete('/:code', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('short_links')
    .delete()
    .eq('code', req.params.code)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
