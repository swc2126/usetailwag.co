/**
 * email.js — sends transactional email via Resend REST API
 * Requires RESEND_API_KEY in environment variables.
 */

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'TailWag <info@usetailwag.co>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Resend API error ${res.status}`);
  }

  return res.json();
}

/**
 * Sends a team member invite email with a join link.
 */
async function sendTeamInvite({ to, inviterName, daycareName, joinUrl }) {
  const subject = `You're invited to join ${daycareName} on TailWag`;
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#F5F0E8;font-family:'Inter',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
        <tr><td align="center">
          <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
            <!-- Header -->
            <tr>
              <td style="background:#0F1410;padding:28px 36px;text-align:center;">
                <span style="font-family:Arial,sans-serif;font-weight:800;font-size:22px;color:#F5F0E8;">🐾 TailWag</span>
              </td>
            </tr>
            <!-- Body -->
            <tr>
              <td style="padding:36px 36px 28px;">
                <h1 style="font-size:22px;font-weight:800;color:#0F1410;margin:0 0 12px;">You've been invited!</h1>
                <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
                  <strong>${escEmail(inviterName)}</strong> has invited you to join
                  <strong>${escEmail(daycareName)}</strong> as a Team Member on TailWag —
                  the AI-powered messaging platform for dog daycares.
                </p>
                <p style="font-size:14px;color:#888;line-height:1.6;margin:0 0 28px;">
                  Click the button below to create your account. Your email address and location
                  are already set — you just need to add your name and create a password.
                </p>
                <!-- CTA Button -->
                <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                  <tr>
                    <td style="background:#1E6B4A;border-radius:8px;">
                      <a href="${joinUrl}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#F5F0E8;text-decoration:none;">
                        Set Up My Account →
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="font-size:12px;color:#bbb;margin:0;">
                  This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.
                </p>
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="padding:20px 36px;border-top:1px solid #f0ece4;">
                <p style="font-size:11px;color:#bbb;margin:0;text-align:center;">
                  TailWag · <a href="https://usetailwag.co" style="color:#1E6B4A;text-decoration:none;">usetailwag.co</a>
                </p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;
  return sendEmail({ to, subject, html });
}

function escEmail(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendEmail, sendTeamInvite };
