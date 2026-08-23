# Webhook Dispatcher

Dispatcher/worker para WhatsApp y Meta (Messenger/Instagram) usando Express + Redis.

## Requisitos

* Docker + Docker Compose
* Variables de entorno:
  * `VERIFY_TOKEN` (verificación WhatsApp)
  * `META_VERIFY_TOKEN` (verificación Meta)
  * `META_APP_SECRET` (App Secret usado para validar `X-Hub-Signature-256` antes de encolar eventos)
  * `WEBHOOK_REDIS_PASSWORD` (secreto obligatorio de Dokploy; usar un valor nuevo, fuerte y URL-safe, por ejemplo el resultado de `openssl rand -hex 32`)
  * `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (workers de WhatsApp, Facebook e Instagram)
  * `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_TIMEOUT_MS` (puente opcional hacia MovIA CRM; requiere una fila con el mismo URL en la tabla del canal)

Compose construye `REDIS_URL` internamente con `webhook-redis:6379`. No se debe configurar un hostname `redis` genérico ni guardar la contraseña en el repositorio.

Ejemplo de configuración (el valor real se guarda como secreto en Dokploy):

```dotenv
WEBHOOK_REDIS_PASSWORD=<strong-url-safe-password>
# URL interna construida por Compose:
REDIS_URL=redis://:${WEBHOOK_REDIS_PASSWORD}@webhook-redis:6379
```

## Seguridad de webhooks

Todos los `POST` de Meta se validan con `META_APP_SECRET` antes de entrar a Redis. Una firma ausente o inválida responde `401`; si el secreto no está configurado, el dispatcher falla cerrado con `500`.

Los webhooks salientes conservan su payload actual y se firman con el valor `secret_signature` de su fila. Si el valor está vacío, el worker crea un secreto aleatorio de 32 bytes (64 caracteres hexadecimales) de forma atómica. Chatwoot (`chat.moviatech.com.mx`, además del hostname legado `chat.moviatech.com`) conserva el flujo existente de body y firma originales de Meta y no recibe firma MovIA.

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
* `webhook-redis`

`webhook-redis` y los cuatro workers solo pertenecen a la red privada `webhook-backend`. `ingress` pertenece a `webhook-backend` y `dokploy-network`; es el único servicio de esta aplicación que Traefik necesita alcanzar. Redis no publica ningún puerto del host y persiste sus datos en el volumen `webhook-redis-data` con AOF habilitado.

## Probar evento Meta (POST)

Los ejemplos deben incluir un `X-Hub-Signature-256` válido calculado con `META_APP_SECRET`. Un POST sin firma o con una firma calculada sobre bytes distintos responderá `401`.

Ejemplo Messenger:

```bash
curl -X POST https://webhook.moviatech.com.mx/webhook/meta \
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
curl -X POST https://webhook.moviatech.com.mx/webhook/meta \
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
node --test tests/*.test.js
```

## Colas en Redis

* WhatsApp: `events`
* Messenger: `events_messenger`
* Instagram: `events_instagram`
* Eventos administrativos de WhatsApp: `non_message`

## Migración desde el Redis compartido

Esta limpieza se realiza una sola vez durante el despliegue que introduce `webhook-backend`. Detén primero `ingress` para impedir nuevos eventos y después detén los cuatro workers:

```bash
docker compose stop ingress
docker compose stop worker_whatsapp worker_meta worker_instagram non_message_worker
```

Elimina únicamente estas cuatro claves tanto del Redis de Sales como del Redis anterior de Webhook:

```text
events
events_messenger
events_instagram
non_message
```

Ejecuta el siguiente comando dentro de cada uno de esos dos contenedores, sustituyendo el nombre del contenedor y obteniendo la contraseña desde su gestor de secretos:

```bash
docker exec <redis-container> redis-cli --no-auth-warning \
  -a '<redis-password>' \
  UNLINK events events_messenger events_instagram non_message
```

No uses `FLUSHDB` ni `FLUSHALL`. La limpieza en ambos Redis es obligatoria porque el conflicto DNS colocó eventos de Webhook en Sales Redis y también dejó claves obsoletas en el Redis anterior de Webhook.

No reutilices la credencial que antes estaba en el repositorio. Después de actualizar el repositorio y configurar un nuevo `WEBHOOK_REDIS_PASSWORD` en Dokploy, inicia los servicios en este orden. `--remove-orphans` elimina el contenedor Redis anterior de este proyecto después de haber limpiado sus claves; no debe aplicarse al proyecto de Sales:

```bash
docker compose up -d --remove-orphans webhook-redis
docker compose up -d worker_whatsapp worker_meta worker_instagram non_message_worker
docker compose up -d ingress
```

Comprueba que cada contenedor de Webhook resuelve exactamente una dirección para `webhook-redis`:

```bash
docker compose exec -T ingress node -e \
  "require('dns').promises.lookup('webhook-redis',{all:true}).then(console.log)"
```

Repite la comprobación para cada worker. Finalmente, comprueba que las cuatro colas comienzan en cero:

```bash
docker compose exec -T webhook-redis sh -c '
  for key in events events_messenger events_instagram non_message; do
    printf "%s: " "$key"
    redis-cli --no-auth-warning -a "$WEBHOOK_REDIS_PASSWORD" LLEN "$key"
  done
'
```
