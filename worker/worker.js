const Redis = require('ioredis');
const axios = require('axios');

const redis = new Redis(process.env.REDIS_URL);

async function processEvent(event) {
  try {
    const parsed = JSON.parse(event);
    const clientWebhook = parsed.clientWebhook; // You should include this in the original event
    console.log(parsed);
    if (clientWebhook) {
      await axios.post(clientWebhook, parsed);
      console.log(`Event forwarded to ${clientWebhook}`);
    } else {
      console.warn('No client webhook specified in event');
    }
  } catch (err) {
    console.error('Error processing event:', err);
  }
}

async function startWorker() {
  console.log('Worker started');

  while (true) {
    const event = await redis.rpop('events');
    if (event) {
      await processEvent(event);
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retrying
    }
  }
}

startWorker();
