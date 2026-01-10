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

// Handle incoming webhook events
app.post('/webhook', async (req, res) => {
  const body = req.body;
  
if (body.object) {
    const fieldType = body.entry?.[0].changes?.[0]?.field; 

    // Guarda paquete completo con raw + headers importantes
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
    } else {
      await redis.lpush('events', JSON.stringify(envelope));
      console.log('Message Event received and pushed to Redis');
      res.sendStatus(200);    
    }
  
  } else {
    res.sendStatus(404);
  }

});

// Handle incoming Meta webhook events (Messenger/Instagram)
app.post('/webhook/meta', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const accountId = entry?.id || null;
    const subchannel = body.object === 'instagram' ? 'instagram' : 'messenger';

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
  } else {
    res.sendStatus(404);
  }
});

app.listen(3000, () => {
  console.log('Dispatcher running on port 3000');
});
