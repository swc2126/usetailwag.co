const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, first_name, last_name, daycare_name, phone, city, state, google_link } = req.body;

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
    await supabaseAdmin.from('daycares').insert({
      owner_id: userId,
      name: daycare_name,
      address: [city, state].filter(Boolean).join(', '),
      phone
    });

    // Create inactive subscription record
    await supabaseAdmin.from('subscriptions').insert({
      user_id: userId,
      status: 'inactive'
    });

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

module.exports = router;
