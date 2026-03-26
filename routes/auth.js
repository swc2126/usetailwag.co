const express = require('express');
const router = express.Router();

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  // TODO: Wire up Supabase Auth (Day 2)
  res.status(501).json({ error: 'Not implemented yet' });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  // TODO: Wire up Supabase Auth (Day 2)
  res.status(501).json({ error: 'Not implemented yet' });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  // TODO: Wire up Supabase Auth (Day 2)
  res.status(501).json({ error: 'Not implemented yet' });
});

module.exports = router;
