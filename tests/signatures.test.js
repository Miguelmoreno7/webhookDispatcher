const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { verifyMetaSignature } = require('../dispatcher/meta-signature');

const signerModules = [
  {
    name: 'WhatsApp',
    signer: require('../worker/webhook-signature'),
    mapping: { table: 'wp_wa_webhooks', ownerColumn: 'waba_id', ownerId: 'waba-1' },
  },
  {
    name: 'Facebook',
    signer: require('../meta_worker/webhook-signature'),
    mapping: { table: 'wp_facebook_webhooks', ownerColumn: 'page_id', ownerId: 'page-1' },
  },
  {
    name: 'Instagram',
    signer: require('../instagram_worker/webhook-signature'),
    mapping: { table: 'wp_instagram', ownerColumn: 'account_id', ownerId: 'ig-1' },
  },
];

test('Meta signature verification authenticates the exact raw body', () => {
  const secret = 'meta-app-secret';
  const raw = Buffer.from('{"message":"hola","unicode":"\\u00e1"}', 'utf8');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

  assert.equal(verifyMetaSignature(raw, signature, secret), true);
  assert.equal(verifyMetaSignature(Buffer.from(`${raw.toString()} `), signature, secret), false);
  assert.equal(verifyMetaSignature(raw, null, secret), false);
  assert.equal(verifyMetaSignature(raw, 'sha256=invalid', secret), false);
  assert.equal(verifyMetaSignature(raw, signature, ''), false);
});

for (const { name, signer, mapping } of signerModules) {
  test(`${name} signs and returns the exact bytes that must be delivered`, () => {
    const secret = 'a'.repeat(64);
    const payload = { hello: 'world', count: 2 };
    const timestamp = '1786254000';
    const deliveryId = 'delivery-123';
    const delivery = signer.createSignedDelivery(payload, secret, { timestamp, deliveryId });
    const expectedBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const expectedDigest = crypto
      .createHmac('sha256', secret)
      .update(Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8'))
      .update(expectedBody)
      .digest('hex');

    assert.deepEqual(delivery.body, expectedBody);
    assert.equal(delivery.headers['X-Movia-Signature-256'], `sha256=${expectedDigest}`);
    assert.equal(delivery.headers['X-Movia-Timestamp'], timestamp);
    assert.equal(delivery.headers['X-Movia-Delivery-Id'], deliveryId);
  });

  test(`${name} reuses an existing signing secret without touching the database`, async () => {
    const pool = { execute: async () => assert.fail('database should not be called') };
    const secret = await signer.ensureSigningSecret(pool, {
      ...mapping,
      webhookUrl: 'https://client.example/webhook',
      currentSecret: `  ${'b'.repeat(64)}  `,
    });

    assert.equal(secret, 'b'.repeat(64));
  });

  test(`${name} atomically creates a missing signing secret`, async () => {
    const calls = [];
    const pool = {
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    };
    const secret = await signer.ensureSigningSecret(pool, {
      ...mapping,
      webhookUrl: 'https://client.example/webhook',
      currentSecret: null,
    });

    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[0], secret);
    assert.deepEqual(calls[0].params.slice(1), [mapping.ownerId, 'https://client.example/webhook']);
    assert.match(calls[0].sql, /secret_signature IS NULL/);
  });

  test(`${name} rereads a secret won by a concurrent worker`, async () => {
    const concurrentSecret = 'c'.repeat(64);
    let call = 0;
    const pool = {
      execute: async () => {
        call += 1;
        return call === 1
          ? [{ affectedRows: 0 }]
          : [[{ secret_signature: concurrentSecret }]];
      },
    };
    const secret = await signer.ensureSigningSecret(pool, {
      ...mapping,
      webhookUrl: 'https://client.example/webhook',
      currentSecret: '',
    });

    assert.equal(secret, concurrentSecret);
    assert.equal(call, 2);
  });
}

test('Chatwoot exception only matches the intended hostname', () => {
  const { isChatwootUrl } = signerModules[0].signer;
  assert.equal(
    isChatwootUrl('https://chat.moviatech.com.mx/webhooks/whatsapp/+5218184705702'),
    true
  );
  assert.equal(isChatwootUrl('https://chat.moviatech.com/webhook'), true);
  assert.equal(isChatwootUrl('https://tenant.chat.moviatech.com/webhook'), true);
  assert.equal(isChatwootUrl('https://chat.moviatech.com.mx.attacker.example/webhook'), false);
  assert.equal(isChatwootUrl('https://chat.moviatech.com.attacker.example/webhook'), false);
  assert.equal(isChatwootUrl('https://attacker.example/?next=chat.moviatech.com'), false);
});
