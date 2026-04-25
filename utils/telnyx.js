// Thin wrapper around the Telnyx SDK so the rest of the app doesn't import it directly.
// Centralizes the API key, messaging profile ID, and webhook signature verification.

const Telnyx = require('telnyx');

const apiKey = process.env.TELNYX_API_KEY;
const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
const publicKey = process.env.TELNYX_PUBLIC_KEY;

const telnyx = apiKey ? Telnyx(apiKey) : null;

// Send an SMS or MMS via Telnyx.
// Returns { id, status } on success, throws on failure.
async function sendSms({ from, to, text, mediaUrls }) {
  if (!telnyx) throw new Error('TELNYX_API_KEY not configured');
  if (!messagingProfileId) throw new Error('TELNYX_MESSAGING_PROFILE_ID not configured');

  const payload = {
    from,
    to,
    text,
    messaging_profile_id: messagingProfileId,
    use_profile_webhooks: true
  };
  if (mediaUrls && mediaUrls.length) payload.media_urls = mediaUrls;

  const res = await telnyx.messages.create(payload);
  // SDK v2 returns { data: { id, to: [...], ... } }
  const data = res?.data || res;
  return { id: data.id, status: 'sent' };
}

// Verify a Telnyx webhook signature (Ed25519).
// Telnyx posts headers `telnyx-signature-ed25519` (base64) and `telnyx-timestamp` (epoch seconds).
// `rawBody` must be the unparsed Buffer/string of the request body.
// Returns the parsed event object on success, throws on failure.
//
// The Telnyx SDK passes signature + publicKey directly to tweetnacl, which requires
// Uint8Array inputs — so we decode the base64-encoded header + key here.
function verifyWebhook(rawBody, signatureHeader, timestampHeader, toleranceSeconds = 300) {
  if (!telnyx) throw new Error('TELNYX_API_KEY not configured');
  if (!publicKey) throw new Error('TELNYX_PUBLIC_KEY not configured');
  if (!signatureHeader) throw new Error('Missing telnyx-signature-ed25519 header');
  if (!timestampHeader) throw new Error('Missing telnyx-timestamp header');

  const signatureBytes = Buffer.from(signatureHeader, 'base64');
  const publicKeyBytes = Buffer.from(publicKey, 'base64');

  return telnyx.webhooks.constructEvent(
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody,
    signatureBytes,
    timestampHeader,
    publicKeyBytes,
    toleranceSeconds
  );
}

// Search + buy a US local number, attached to our messaging profile.
// Used by both the manual provision route and the post-checkout auto-provision.
async function purchaseLocalNumber({ areaCode, label }) {
  if (!telnyx) throw new Error('TELNYX_API_KEY not configured');

  const searchFilter = {
    'filter[country_code]': 'US',
    'filter[features][]': ['sms', 'mms'],
    'filter[phone_number_type]': 'local',
    'filter[limit]': 1
  };
  if (areaCode) searchFilter['filter[national_destination_code]'] = areaCode;

  const available = await telnyx.availablePhoneNumbers.list(searchFilter);
  const list = available?.data || [];
  if (!list.length) {
    const err = new Error(areaCode ? 'No numbers available in that area code.' : 'No local numbers available.');
    err.code = 'NO_NUMBERS';
    throw err;
  }

  const order = await telnyx.numberOrders.create({
    phone_numbers: [{ phone_number: list[0].phone_number }],
    messaging_profile_id: messagingProfileId,
    customer_reference: label
  });

  const orderData = order?.data || order;
  const phoneNumber = orderData?.phone_numbers?.[0]?.phone_number || list[0].phone_number;
  const providerId = orderData?.phone_numbers?.[0]?.id || orderData?.id;

  return { phone_number: phoneNumber, provider_id: providerId };
}

module.exports = { telnyx, sendSms, verifyWebhook, purchaseLocalNumber };
