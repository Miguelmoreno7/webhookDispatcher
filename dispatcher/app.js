// Import Express.js
const express = require('express');

const bodyParser = require('body-parser');
const Redis = require('ioredis');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
// app.use(express.json());
// Captura rawBody SIN perder req.body
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // Buffer raw exacto
  }
}));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const redis = new Redis(process.env.REDIS_URL);

// Meta webhook verification
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

async function handleWebhook(req, res) {
  const body = req.body;

  if (!body.object) {
    res.sendStatus(404);
    return;
  }

  const isInstagram = body.object === 'instagram';
  const isMessenger = body.object === 'page';
  const subchannel = isInstagram ? 'instagram' : isMessenger ? 'messenger' : 'whatsapp';

  if (subchannel === 'whatsapp') {
    const fieldType = body.entry?.[0].changes?.[0]?.field;

    const envelope = {
      raw: req.rawBody?.toString('utf8') ?? JSON.stringify(body),
      // Firma de Meta (si viene)
      sig: req.get('x-hub-signature-256') || null,
      contentType: req.get('content-type') || 'application/json',
      receivedAt: Date.now(),
    };

    if (fieldType !== 'messages') {
      await redis.lpush('non_message', JSON.stringify(body));
      console.log('Non Message received and pushed to Redis');
      res.sendStatus(200);
      return;
    }

    await redis.lpush('events', JSON.stringify(envelope));
    console.log('Message Event received and pushed to Redis');
    res.sendStatus(200);
    return;
  }

  const entry = body.entry?.[0];
  const accountId = entry?.id || null;

  const envelope = {
    channel: 'meta',
    subchannel,
    account_id: accountId,
    received_at: new Date().toISOString(),
    raw: req.rawBody?.toString('utf8') ?? JSON.stringify(body),
    parsed: body,
  };

  const queueName = subchannel === 'instagram' ? 'events_instagram' : 'events_messenger';
  await redis.lpush(queueName, JSON.stringify(envelope));
  console.log(`Meta event (${subchannel}) received and pushed to Redis (${queueName})`);
  res.sendStatus(200);
}

// Handle incoming webhook events
app.post('/webhook', handleWebhook);

// Handle incoming Meta webhook events (Messenger/Instagram)
app.post('/webhook/meta', handleWebhook);

app.listen(3000, () => {
  console.log('Dispatcher running on port 3000');
});
