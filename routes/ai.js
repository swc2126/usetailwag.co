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
- STRICT LIMIT: message must be 160 characters or fewer — count carefully before responding
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

// POST /api/ai/review-request — generate a personalized review request SMS
router.post('/review-request', requireAuth, async (req, res) => {
  const { owner_first_name, dog_name, breed, age, weight, dog_notes, medications, daycare_name, google_link } = req.body;

  if (!owner_first_name || !dog_name) {
    return res.status(400).json({ error: 'owner_first_name and dog_name required' });
  }

  // Build rich dog context
  const dogDetails = [
    breed                    && `Breed: ${breed}`,
    age != null && age !== '' && `Age: ${age} year${age == 1 ? '' : 's'} old`,
    weight                   && `Weight: ${weight} lbs`,
    medications              && `Medications: ${medications}`,
    dog_notes                && `Staff notes: ${dog_notes}`
  ].filter(Boolean).join('\n');

  // Link appended server-side so AI stays under 120 chars (leaving room for the link)
  const linkBudget = google_link ? google_link.length + 1 : 0; // +1 for space
  const textBudget = 155 - linkBudget;

  const prompt = `You write highly personalized review request SMS messages for dog daycares. Each message should feel like it came from someone who genuinely knows and loves this specific dog — not a template.

PET PARENT FIRST NAME: ${owner_first_name}
DOG NAME: ${dog_name}
${dogDetails}
DAYCARE NAME: ${daycare_name || 'our daycare'}

RULES (all are mandatory):
1. Do NOT open with "Hi", "Hey", "Hello", or any greeting word
2. Do NOT use "fur baby", "pup", "furry friend", or "pooch"
3. Open with something specific and vivid about THIS dog — reference their breed personality, age, size, or a detail from staff notes. Make it feel observed, not guessed.
4. Use ${dog_name}'s name at least once, naturally
5. Use ${owner_first_name}'s name exactly once, woven in mid-message or near the end — never first word
6. The review ask should feel warm and earned — something like "if you have a moment" or "it would mean a lot" — never pushy or transactional
7. Do NOT include any URL or link — the link will be added automatically
${google_link ? `8. Ask them to leave a Google review (link will be appended automatically)` : `8. Ask them to search for ${daycare_name || 'the daycare'} on Google to leave a review`}
9. STRICT LIMIT: total message (including link if present) must be 175 characters or fewer — count carefully
10. At most one emoji — only if it genuinely fits. No forced emoji.
11. Sound like a real, warm human wrote it — not a bot, not marketing copy

Write ONLY the message text (no link). No quotes. No explanation. No labels.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    let text = message.content[0].text.trim();
    // Append link server-side
    if (google_link) text = `${text} ${google_link}`;
    res.json({ message: text, chars: text.length });
  } catch (err) {
    console.error('AI review-request error:', err.message);
    res.status(500).json({ error: 'Failed to generate message' });
  }
});

module.exports = router;
