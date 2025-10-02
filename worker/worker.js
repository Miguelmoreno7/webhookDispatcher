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
console.log(dbConfig);

async function getWebhooksForPhone(phoneNumberId) {
  const connection = await mysql.createConnection(dbConfig);
  const [rows] = await connection.execute(
    'SELECT webhook_url FROM wp_wa_webhooks WHERE waba_id = ?',
    [phoneNumberId]
  );
  console.log(rows);
  await connection.end();
  return rows.map(row => row.webhook_url);
}


async function processEvent(event) {
  try {
    const parsed = JSON.parse(event);
    
    // Extract phone number ID from the first entry
    const entry = parsed.entry?.[0];
    const phoneNumberId = entry?.id;

    const webhookUrls = await getWebhooksForPhone(phoneNumberId);

    for (const url of webhookUrls) {
      try {
        await axios.post(url, parsed);
        console.log(`Event forwarded to ${url}`);
      } catch (err) {
        console.error(`Failed to send event to ${url}:`, err.message);
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
