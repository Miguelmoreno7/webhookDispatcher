const crypto = require('crypto');
const axios = require('axios');
const { createSignedDelivery } = require('./webhook-signature');

function deliveryId(channel, raw) {
  return `${channel.toLowerCase()}:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

async function forwardToCrm({ channel, eventType, resourceId, payload, raw, receivedAt, signingSecret }) {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url || !signingSecret || !resourceId) return;
  try {
    const id = deliveryId(channel, raw);
    const delivery = createSignedDelivery({
      schemaVersion: 1,
      deliveryId: id,
      channel,
      eventType,
      resourceId: String(resourceId),
      receivedAt: receivedAt || new Date().toISOString(),
      payload,
    }, signingSecret, { deliveryId: id });
    await axios.post(url, delivery.body, {
      headers: {
        ...delivery.headers,
        'x-movia-dispatcher-schema': '1',
      },
      transformRequest: [(data) => data],
      timeout: Number(process.env.CRM_WEBHOOK_TIMEOUT_MS || 3000),
      maxBodyLength: Infinity,
    });
  } catch (error) {
    console.error(`[CRM bridge] WhatsApp delivery failed: ${error.message}`);
  }
}

module.exports = { forwardToCrm };
