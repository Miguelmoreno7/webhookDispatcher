const crypto = require('crypto');

const TABLE_OWNER_COLUMNS = Object.freeze({
  wp_instagram: 'account_id',
});

function normalizeSecret(secret) {
  return typeof secret === 'string' ? secret.trim() : '';
}

function generateSigningSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function isChatwootUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const chatwootHosts = ['chat.moviatech.com.mx', 'chat.moviatech.com'];
    return chatwootHosts.some(
      (chatwootHost) => hostname === chatwootHost || hostname.endsWith(`.${chatwootHost}`)
    );
  } catch {
    return false;
  }
}

function createSignedDelivery(payload, secret, options = {}) {
  const normalizedSecret = normalizeSecret(secret);
  if (!normalizedSecret) {
    throw new Error('A webhook signing secret is required');
  }

  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const deliveryId = options.deliveryId || crypto.randomUUID();
  const prefix = Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8');
  const digest = crypto
    .createHmac('sha256', normalizedSecret)
    .update(prefix)
    .update(body)
    .digest('hex');

  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Movia-Signature-256': `sha256=${digest}`,
      'X-Movia-Timestamp': timestamp,
      'X-Movia-Delivery-Id': deliveryId,
    },
  };
}

async function ensureSigningSecret(pool, { table, ownerColumn, ownerId, webhookUrl, currentSecret }) {
  if (TABLE_OWNER_COLUMNS[table] !== ownerColumn) {
    throw new Error(`Unsupported webhook table mapping: ${table}.${ownerColumn}`);
  }

  const existing = normalizeSecret(currentSecret);
  if (existing) {
    return existing;
  }

  const candidate = generateSigningSecret();
  const [result] = await pool.execute(
    `UPDATE ${table}
     SET secret_signature = ?
     WHERE ${ownerColumn} = ?
       AND webhook_url = ?
       AND (secret_signature IS NULL OR TRIM(secret_signature) = '')`,
    [candidate, ownerId, webhookUrl]
  );

  if (result.affectedRows === 1) {
    return candidate;
  }

  const [rows] = await pool.execute(
    `SELECT secret_signature
     FROM ${table}
     WHERE ${ownerColumn} = ? AND webhook_url = ?
     LIMIT 1`,
    [ownerId, webhookUrl]
  );
  const concurrentSecret = normalizeSecret(rows[0]?.secret_signature);
  if (!concurrentSecret) {
    throw new Error(`Unable to provision signing secret for ${table} webhook`);
  }

  return concurrentSecret;
}

module.exports = {
  createSignedDelivery,
  ensureSigningSecret,
  generateSigningSecret,
  isChatwootUrl,
};
