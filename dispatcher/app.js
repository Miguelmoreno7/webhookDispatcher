// Import Express.js
const express = require('express');

const bodyParser = require('body-parser');
const Redis = require('ioredis');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

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
    await redis.lpush('events', JSON.stringify(body));
    console.log('Event received and pushed to Redis');
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }

});

app.listen(3000, () => {
  console.log('Dispatcher running on port 3000');
});
