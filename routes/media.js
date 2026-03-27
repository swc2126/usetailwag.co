const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Allowed: jpg, png, gif, webp, mp4, mov'));
  }
});

const supabaseStorage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/media/upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const ext = req.file.originalname.split('.').pop();
  const fileName = `${req.daycareId}/${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;
  const isVideo = req.file.mimetype.startsWith('video/');
  const bucket = isVideo ? 'tailwag-videos' : 'tailwag-media';

  const { error: uploadError } = await supabaseStorage.storage
    .from(bucket)
    .upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data: { publicUrl } } = supabaseStorage.storage.from(bucket).getPublicUrl(fileName);

  // Log to media table
  const { supabaseAdmin } = require('../config/supabase');
  await supabaseAdmin.from('media').insert({
    daycare_id: req.daycareId,
    uploader_id: req.user.id,
    storage_path: fileName,
    public_url: publicUrl,
    file_type: isVideo ? 'video' : 'image',
    file_size: req.file.size
  });

  res.json({ success: true, url: publicUrl, type: isVideo ? 'video' : 'image' });
});

module.exports = router;
