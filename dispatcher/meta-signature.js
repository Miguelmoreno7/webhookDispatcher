const crypto = require('crypto');

function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !appSecret || typeof signatureHeader !== 'string') {
    return false;
  }

  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signatureHeader.trim());
  if (!match) {
    return false;
  }

  const received = Buffer.from(match[1], 'hex');
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest();

  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function createMetaSignatureMiddleware(appSecret) {
  return function requireMetaSignature(req, res, next) {
    if (!appSecret) {
      console.error('META_APP_SECRET is not configured; rejecting Meta webhook');
      return res.sendStatus(500);
    }

    const signature = req.get('x-hub-signature-256');
    if (!verifyMetaSignature(req.rawBody, signature, appSecret)) {
      console.warn('Rejected Meta webhook with missing or invalid signature');
      return res.sendStatus(401);
    }

    return next();
  };
}

module.exports = { verifyMetaSignature, createMetaSignatureMiddleware };
