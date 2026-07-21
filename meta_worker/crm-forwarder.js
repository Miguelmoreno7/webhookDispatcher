const crypto = require('crypto');
const axios = require('axios');

async function forwardToCrm({ eventType, resourceId, payload, raw, receivedAt }) {
  const url = process.env.CRM_WEBHOOK_URL;
  const secret = process.env.CRM_WEBHOOK_SECRET;
  if (!url || !secret || !resourceId) return;
  try {
    await axios.post(url, {
      schemaVersion: 1,
      deliveryId: `facebook:${crypto.createHash('sha256').update(raw).digest('hex')}`,
      channel: 'FACEBOOK',
      eventType,
      resourceId: String(resourceId),
      receivedAt: receivedAt || new Date().toISOString(),
      payload,
    }, { headers: { 'Content-Type': 'application/json', 'x-movia-dispatcher-secret': secret, 'x-movia-dispatcher-schema': '1' }, timeout: Number(process.env.CRM_WEBHOOK_TIMEOUT_MS || 3000), maxBodyLength: Infinity });
  } catch (error) {
    console.error(`[CRM bridge] Facebook delivery failed: ${error.message}`);
  }
}

module.exports = { forwardToCrm };
