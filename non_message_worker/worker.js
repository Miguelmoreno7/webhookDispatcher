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

//Function to get the update the database that matches the phone id
async function updateDataBase(phoneNumberId, eventValue) {
  const connection = await mysql.createConnection(dbConfig);
  try {
    const [result] = await connection.execute(
      'UPDATE wp_wa_webhooks SET status = ? WHERE waba_id = ?',
      [eventValue, phoneNumberId]
    );
    console.log(`Updated status for waba_id ${phoneNumberId}:`, result);
  } catch (error) {
    console.error('Error updating status:', error);
  } finally {
    await connection.end();
  }

}

//Function to delete the row in case phone number is eliminated from the app
async function deleteRowDataBase(phoneNumberId) {
  const connection = await mysql.createConnection(dbConfig);

  try {
    const [result] = await connection.execute(
      'DELETE FROM wp_wa_webhooks WHERE waba_id = ?',
      [phoneNumberId]
    );
    console.log(`Deleted row for waba_id ${phoneNumberId}:`, result);
  } catch (error) {
    console.error('Error deleting row:', error);
  } finally {
    await connection.end();
  }
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

    switch(fieldType) {
      case 'account_update': 
        const eventValue = value.event;
        const blockedEvents = ['ACCOUNT_DELETED', 'PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED'];
        if (blockedEvents.includes(eventValue)) {
          await deleteRowDataBase(phoneNumberId);
        } else {
          await updateDataBase(phoneNumberId, eventValue);
        }
        break;
      default:
        console.log('Not valid field type');
    }

  } catch (err) {
    console.error('Error processing event:', err);
  }
}

async function startWorker() {
  console.log('Worker started');

  while (true) {
    const event = await redis.rpop('non_message');
    if (event) {
      await processEvent(event);
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retrying
    }
  }
}

startWorker();
