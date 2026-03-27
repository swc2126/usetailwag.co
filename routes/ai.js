const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/ai/report-card — generate a personalized report card message
router.post('/report-card', requireAuth, async (req, res) => {
  const { dog_name, owner_first_name, breed, notes, daycare_name } = req.body;

  if (!dog_name || !owner_first_name) {
    return res.status(400).json({ error: 'dog_name and owner_first_name required' });
  }

  const prompt = `You are writing a personalized dog daycare report card SMS message.

Dog: ${dog_name}
Breed: ${breed || 'Mixed breed'}
Owner first name: ${owner_first_name}
Daycare: ${daycare_name || 'the daycare'}
Staff notes: ${notes || 'Had a good day'}

Rules:
- NEVER start with "Hi", "Hey", "Hello", or any greeting
- NEVER say "your pup", "your fur baby", "your furry friend"
- Jump straight into something specific and vivid about the dog's day
- Match the dog's energy in word choice (use the notes to infer energy level)
- Use the owner's first name ONCE, naturally woven in — never at the start
- End with at most ONE casual emoji, only if it feels natural
- Keep the message between 175-200 characters total
- Sound like a real person wrote it, not a template
- Be specific to the notes provided — no generic openers

Write ONLY the SMS message text. No quotes, no explanation.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content[0].text.trim();
    res.json({ message: text, chars: text.length });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Failed to generate message: ' + err.message });
  }
});

module.exports = router;
