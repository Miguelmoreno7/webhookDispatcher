const Redis = require('ioredis');
const axios = require('axios');
const mysql = require('mysql2/promise');

const redis = new Redis(process.env.REDIS_URL);
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const allowedEventTypes = new Set(['messages', 'feed', 'likes', 'posts', 'media', 'comments']);

async function forwardRawEvent(raw, webhookUrl) {
  for (const url of webhookUrl) {
    if (!url) continue;

    try {
      await axios.post(url, raw, {
        headers: {
          'Content-Type': 'application/json',
        },
        transformRequest: [(data) => data],
        timeout: 10000,
        maxBodyLength: Infinity,
      });
      console.log(`Forwarded instagram event to ${url}`);
    } catch (err) {
      console.error(`Failed to forward instagram event to ${url}:`, err.message);
    }
  }
}

function extractMessagingEvents(entry) {
  if (Array.isArray(entry?.messaging)) {
    return entry.messaging;
  }

  const changesMessages = entry?.changes?.[0]?.value?.messages;
  if (Array.isArray(changesMessages)) {
    return changesMessages;
  }

  return [];
}

function normalizeMessages(envelope) {
  const parsed = envelope.parsed || JSON.parse(envelope.raw);
  const entries = Array.isArray(parsed.entry) ? parsed.entry : [];
  const normalized = [];

  for (const entry of entries) {
    const messagingEvents = extractMessagingEvents(entry);
    if (!messagingEvents.length) {
      continue;
    }

    for (const event of messagingEvents) {
      const text = event?.message?.text || event?.text || null;
      if (!text) {
        continue;
      }

      normalized.push({
        channel: envelope.subchannel,
        account_id: envelope.account_id || entry?.id || null,
        sender_id: event?.sender?.id || event?.from?.id || null,
        text,
        timestamp: event?.timestamp || event?.message?.timestamp || event?.time || null,
        raw: event,
      });
    }
  }

  return normalized;
}

function getEventType(parsed) {
  const entry = parsed.entry?.[0];
  if (Array.isArray(entry?.messaging)) {
    return 'messages';
  }
  return entry?.changes?.[0]?.field || null;
}

function isAllowedEventType(eventType) {
  if (!eventType) {
    return false;
  }
  return allowedEventTypes.has(eventType);
}

async function getWebhookUrl(accountId) {
  if (!accountId) {
    return null;
  }
  const [rows] = await pool.execute(
    'SELECT webhook_url FROM wp_instagram WHERE account_id = ?',
    [accountId]
  );
  return rows;
}

async function processEvent(event) {
  try {
    const envelope = JSON.parse(event);
    const parsed = envelope.parsed || JSON.parse(envelope.raw);
    const eventType = getEventType(parsed);
    if (!isAllowedEventType(eventType)) {
      console.log(`Skipping instagram event type: ${eventType}`);
      return;
    }

    const accountId = envelope.account_id || parsed.entry?.[0]?.id || null;
    const webhookUrl = await getWebhookUrl(accountId);
    await forwardRawEvent(envelope.raw, webhookUrl);
    const messages = normalizeMessages(envelope);

    if (!messages.length) {
      console.log('No message events to normalize');
      return;
    }

    for (const message of messages) {
      console.log('Normalized instagram message:', JSON.stringify(message));
    }
  } catch (err) {
    console.error('Error processing instagram event:', err);
  }
}

async function startWorker() {
  console.log('Instagram worker started');

  while (true) {
    const result = await redis.brpop('events_instagram', 0);
    if (result && result[1]) {
      await processEvent(result[1]);
    }
  }
}

startWorker();
