# Webhook Dispatcher

Dispatcher/worker para WhatsApp y Meta (Messenger/Instagram) usando Express + Redis.

## Requisitos

* Docker + Docker Compose
* Variables de entorno:
  * `VERIFY_TOKEN` (verificación WhatsApp)
  * `META_VERIFY_TOKEN` (verificación Meta)
  * `REDIS_URL` (por ejemplo `redis://:RealUnited93@redis:6379`)
  * `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (solo para workers de WhatsApp)

## Levantar servicios

```bash
docker compose up --build
```

Servicios:
* `ingress` (dispatcher)
* `worker_whatsapp`
* `worker_meta` (Messenger)
* `worker_instagram`
* `non_message_worker`
* `redis`

## Probar evento Meta (POST)

Ejemplo Messenger:

```bash
curl -X POST http://localhost:3000/webhook/meta \
  -H "Content-Type: application/json" \
  -d '{
    "object": "page",
    "entry": [
      {
        "id": "1234567890",
        "time": 1710000000,
        "messaging": [
          {
            "sender": {"id": "USER_ID"},
            "recipient": {"id": "PAGE_ID"},
            "timestamp": 1710000001,
            "message": {"mid": "m_1", "text": "Hola"}
          }
        ]
      }
    ]
  }'
```

Ejemplo Instagram:

```bash
curl -X POST http://localhost:3000/webhook/meta \
  -H "Content-Type: application/json" \
  -d '{
    "object": "instagram",
    "entry": [
      {
        "id": "17841400000000000",
        "time": 1710000000,
        "messaging": [
          {
            "sender": {"id": "IG_USER_ID"},
            "recipient": {"id": "IG_ACCOUNT_ID"},
            "timestamp": 1710000002,
            "message": {"mid": "m_2", "text": "Hola IG"}
          }
        ]
      }
    ]
  }'
```

Los workers `worker_meta` (Messenger) y `worker_instagram` normalizan y loguean los mensajes en el formato interno.

## Colas en Redis

* WhatsApp: `events`
* Messenger: `events_messenger`
* Instagram: `events_instagram`
