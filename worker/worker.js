const Redis = require('ioredis');
const axios = require('axios');
const mysql = require('mysql2/promise');

const redis = new Redis(process.env.REDIS_URL);
const WORKER_HEALTH_INTERVAL_MS = Number(process.env.WORKER_HEALTH_INTERVAL_MS || 60000);

redis.on('connect', () => console.log('[WhatsApp Worker] Redis connected'));
redis.on('error', (err) => console.error('[WhatsApp Worker] Redis error:', err.message));

//Connect to the database
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

//Function to send the event to the webhook
async function forwardEvent(url, payload, eventType, metaCtx) {
  try {
    // Chatwoot needs RAW body + signature header (if present)
    if (url && url.includes('chat.moviatech.com')) {
      const headers = {
        'Content-Type': metaCtx?.contentType || 'application/json',
      };

      // Forward Meta signature if available
      if (metaCtx?.sig) {
        headers['X-Hub-Signature-256'] = metaCtx.sig;
      }

      await axios.post(url, metaCtx.raw, {
        headers,
        // Prevent axios from re-stringifying / mutating the raw JSON
        transformRequest: [(data) => data],
        timeout: 10000,
        maxBodyLength: Infinity,
      });

      console.log(`[Chatwoot] Event ${eventType} forwarded to ${url}`);
      return;
    }
    // Default behavior (n8n / Make / others): send parsed payload (value)
    await axios.post(url, payload, {
      timeout: 10000,
      maxBodyLength: Infinity,
    });
    console.log(`Event ${eventType} forwarded to ${url}`);
  } catch (err) {
    console.error(`Failed to send ${eventType} to ${url}:`, err.message);
  }
}

//Function to get the Webhooks from the database that matches the phone id
async function getWebhooksForPhone(phoneNumberId) {
  const [configRows] = await pool.execute(
    'SELECT is_locked, is_active FROM wp_wa_configurations WHERE waba_id = ? LIMIT 1',
    [phoneNumberId]
  );

  if (configRows.length === 0 || configRows[0].is_locked !== 0 || configRows[0].is_active !== 1) {
    // WABA is either locked or inactive — block webhook processing
    console.error(`WABA locked or inactive: ${phoneNumberId}`);
    return [];
  }

  const [rows] = await pool.execute(
    'SELECT webhook_url, message_received, message_sent, message_delivered, message_read FROM wp_wa_webhooks WHERE waba_id = ?',
    [phoneNumberId]
  );
  return rows;
}

//Function to update Messages Sent 
async function updateMessagesSent(phoneNumberId) {
  //Extract user_id
  const [configRows] = await pool.execute(
      `SELECT user_id FROM wp_wa_configurations WHERE waba_id = ?`,
      [phoneNumberId]
  );
  
  const { user_id } = configRows[0];

  // 2. Check subscription plan for this user
  const [subRows] = await pool.execute(
      `SELECT subscription_plan_id FROM wp_pms_member_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [user_id]
  );

  //Get subscription plan id
  let subscriptionPlanId = subRows[0].subscription_plan_id;

  //If admins set subscription plan 1
  if (user_id === 6 || user_id === 2) {
    subscriptionPlanId = 1;
  }
  
  //If bronze, restrict messages
  if (subscriptionPlanId === 2986) {
    await pool.execute(
      `UPDATE wp_wa_configurations
       SET messages_sent = messages_sent + 1,
           is_locked = CASE WHEN messages_sent + 1 >= 250 THEN 1 ELSE is_locked END
       WHERE waba_id = ?`,
      [phoneNumberId]
    );
  } else {
    await pool.execute(
      `UPDATE wp_wa_configurations
       SET messages_sent = messages_sent + 1
       WHERE waba_id = ?`,
      [phoneNumberId]
    );
  }
}

async function processEvent(event) {
  try {
    console.log('[WhatsApp Worker] Processing event from Redis');
    // const parsed = JSON.parse(event);
    const envelope = JSON.parse(event);       // { raw, sig, contentType, receivedAt }
    const parsed = JSON.parse(envelope.raw);  // full Meta payload
    // Extract phone number ID from the first entry
    const entry = parsed.entry?.[0];
    const phoneNumberId = entry?.id;
    const fieldType = entry?.changes?.[0]?.field;
    const value = entry?.changes?.[0]?.value;

    console.log(`[WhatsApp Worker] Parsed event field=${fieldType || 'unknown'} phone=${phoneNumberId || 'unknown'}`);

    let eventType = null;
    
    //Check if the event is a message
    if (fieldType !== 'messages') {
      console.log(`Skipping event with field type: ${fieldType}`);
      return;
    }
    if (value?.statuses?.length > 0) {
      const status = value.statuses[0].status;
      console.log(`Status: ${status}`);
      switch (status) {
        case 'sent': 
          eventType = 'message_sent'; 
          await updateMessagesSent(phoneNumberId);
          break;
        case 'delivered': eventType = 'message_delivered'; break;
        case 'read': eventType = 'message_read'; break;
        default:
          console.log(`Unknown status: ${status}`);
          return;
      }
    } else {
      eventType = 'message_received';
    }

    const webhookUrls = await getWebhooksForPhone(phoneNumberId);
    console.log(`[WhatsApp Worker] Found ${webhookUrls.length} webhook row(s) for ${phoneNumberId}`);
      
    for (const url of webhookUrls) {
      if (url[eventType]) {
        await forwardEvent(url.webhook_url, value, eventType, envelope);
      }
    }
  } catch (err) {
    console.error('Error processing event:', err);
  }
}

async function logWorkerHealth() {
  try {
    const queueLength = await redis.llen('events');
    console.log(`[WhatsApp Worker] Health OK - events queue length: ${queueLength}`);
  } catch (err) {
    console.error('[WhatsApp Worker] Health check failed:', err.message);
  }
}

async function startWorker() {
  console.log('[WhatsApp Worker] Worker started');
  setInterval(logWorkerHealth, WORKER_HEALTH_INTERVAL_MS);

  while (true) {
    const result = await redis.brpop('events', 0);
    if (result && result[1]) {
      console.log('[WhatsApp Worker] Event popped from Redis queue');
      await processEvent(result[1]);
    }
  }
}

startWorker();
