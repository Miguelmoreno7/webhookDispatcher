const Redis = require('ioredis');
const axios = require('axios');
const mysql = require('mysql2/promise');

const redis = new Redis(process.env.REDIS_URL);

//Connect to the database
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

//Function to send the event to the webhook
async function forwardEvent(url, payload, eventType) {
  try {
    await axios.post(url, payload);
    console.log(`Event ${eventType} forwarded to ${url}`);
  } catch (err) {
    console.error(`Failed to send ${eventType} to ${url}:`, err.message);
  }
}

//Function to get the Webhooks from the database that matches the phone id
async function getWebhooksForPhone(phoneNumberId) {
  const connection = await mysql.createConnection(dbConfig);
  const [rows] = await connection.execute(
    'SELECT webhook_url, message_received, message_sent, message_delivered, message_read FROM wp_wa_webhooks WHERE waba_id = ?',
    [phoneNumberId]
  );
  console.log(rows);
  await connection.end();
  return rows;
}


async function processEvent(event) {
  try {
    const parsed = JSON.parse(event);
    
    // Extract phone number ID from the first entry
    const entry = parsed.entry?.[0];
    const phoneNumberId = entry?.id;
    const fieldType = entry?.changes?.[0]?.field;
    const value = entry?.changes?.[0]?.value;

    let eventType = null;
    
    //Check if the event is a message
    if (fieldType !== 'messages') {
      console.log(`Skipping event with field type: ${fieldType}`);
      return;
    }
    if (value?.statuses?.length > 0) {
      const status = value.statuses[0].status;
      switch (status) {
        case 'sent': eventType = 'message_sent'; break;
        case 'delivered': eventType = 'message_delivered'; break;
        case 'read': eventType = 'message_read'; break;
        default:
          console.log(`Unknown status: ${status}`);
          return;
    } else {
      eventType = 'message_received';
    }

    const webhookUrls = await getWebhooksForPhone(phoneNumberId);
      
    for (const url of webhookUrls) {
      if (webhook[eventType]) {
        await forwardEvent(webhook.webhook_url, value, eventType);
      }
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
