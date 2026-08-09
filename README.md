# Webhook Dispatcher

Dispatcher/worker para WhatsApp y Meta (Messenger/Instagram) usando Express + Redis.

## Requisitos

* Docker + Docker Compose
* Variables de entorno:
  * `VERIFY_TOKEN` (verificación WhatsApp)
  * `META_VERIFY_TOKEN` (verificación Meta)
  * `META_APP_SECRET` (App Secret usado para validar `X-Hub-Signature-256` antes de encolar eventos)
  * `REDIS_URL` (por ejemplo `redis://:RealUnited93@redis:6379`)
  * `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (workers de WhatsApp, Facebook e Instagram)
  * `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_TIMEOUT_MS` (puente opcional hacia MovIA CRM; requiere una fila con el mismo URL en la tabla del canal)

## Seguridad de webhooks

Todos los `POST` de Meta se validan con `META_APP_SECRET` antes de entrar a Redis. Una firma ausente o inválida responde `401`; si el secreto no está configurado, el dispatcher falla cerrado con `500`.

Los webhooks salientes conservan su payload actual y se firman con el valor `secret_signature` de su fila. Si el valor está vacío, el worker crea un secreto aleatorio de 32 bytes (64 caracteres hexadecimales) de forma atómica. Chatwoot (`chat.moviatech.com`) conserva el flujo existente de body y firma originales de Meta y no recibe firma MovIA.

Headers enviados a los demás destinos:

* `X-Movia-Signature-256: sha256=<digest>`
* `X-Movia-Timestamp: <unix-seconds>`
* `X-Movia-Delivery-Id: <unique-id>`

La entrada firmada es la concatenación de `timestamp`, `deliveryId` y los bytes exactos del body:

```text
<timestamp>.<deliveryId>.<body>
```

El receptor debe calcular HMAC-SHA256 con su `secret_signature`, comparar en tiempo constante, rechazar timestamps antiguos y deduplicar `X-Movia-Delivery-Id`.

Las tablas consultadas por los workers deben tener una columna nullable:

```sql
secret_signature VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL
```

Para el puente CRM, `CRM_WEBHOOK_URL` debe coincidir exactamente con un `webhook_url` de la cuenta en la tabla correspondiente. Esa fila controla los eventos habilitados y proporciona el secreto de la entrega CRM.

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

Los ejemplos deben incluir un `X-Hub-Signature-256` válido calculado con `META_APP_SECRET`. Un POST sin firma o con una firma calculada sobre bytes distintos responderá `401`.

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

## Pruebas

```bash
node --test tests/signatures.test.js
```

## Colas en Redis

* WhatsApp: `events`
* Messenger: `events_messenger`
* Instagram: `events_instagram`
