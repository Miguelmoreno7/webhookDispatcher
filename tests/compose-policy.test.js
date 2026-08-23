const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const composePath = path.join(repositoryRoot, 'docker-compose.yml');
const dockerAvailable = spawnSync('docker', ['compose', 'version'], {
  stdio: 'ignore',
}).status === 0;

function serviceNetworks(service) {
  return Object.keys(service.networks || {}).sort();
}

test('repository does not contain a hard-coded Redis password or bare Redis URL', () => {
  const files = ['docker-compose.yml', 'README.md'];
  const source = files
    .map((file) => readFileSync(path.join(repositoryRoot, file), 'utf8'))
    .join('\n');

  assert.doesNotMatch(source, /redis:\/\/:(?!\$\{)[^@\s]+@/);
  assert.doesNotMatch(source, /@redis:6379/);
  assert.doesNotMatch(source, /container_name\s*:/);
});

test('production Compose isolates and hardens webhook-redis', { skip: !dockerAvailable }, () => {
  const environment = {
    ...process.env,
    WEBHOOK_REDIS_PASSWORD: 'ci-only-url-safe-password',
    VERIFY_TOKEN: 'ci-verify-token',
    META_VERIFY_TOKEN: 'ci-meta-verify-token',
    META_APP_SECRET: 'ci-meta-app-secret',
    DB_HOST: 'db.example.test',
    DB_USER: 'ci-user',
    DB_PASSWORD: 'ci-password',
    DB_NAME: 'ci-database',
  };
  const rendered = execFileSync(
    'docker',
    ['compose', '-f', composePath, 'config', '--format', 'json'],
    { cwd: repositoryRoot, env: environment, encoding: 'utf8' }
  );
  const config = JSON.parse(rendered);
  const services = config.services;
  const redis = services['webhook-redis'];
  const clients = [
    'ingress',
    'worker_whatsapp',
    'worker_meta',
    'worker_instagram',
    'non_message_worker',
  ];
  const workers = clients.filter((service) => service !== 'ingress');

  assert.ok(redis, 'webhook-redis service must exist');
  assert.equal(services.redis, undefined, 'bare redis service must not exist');
  assert.deepEqual(serviceNetworks(redis), ['webhook-backend']);
  assert.equal(redis.ports, undefined, 'Redis must not publish a host port');
  assert.match(redis.command.join(' '), /--requirepass/);
  assert.match(redis.command.join(' '), /--appendonly yes/);
  assert.ok(redis.healthcheck, 'Redis must define a healthcheck');
  assert.ok(
    redis.volumes.some((volume) => volume.target === '/data'),
    'Redis must persist /data in a named volume'
  );

  assert.deepEqual(serviceNetworks(services.ingress), [
    'dokploy-network',
    'webhook-backend',
  ]);
  assert.equal(services.ingress.ports, undefined, 'Ingress must not publish a random host port');
  assert.ok(
    (services.ingress.expose || []).some((port) => String(port).startsWith('3000')),
    'Ingress must expose container port 3000'
  );
  assert.equal(
    services.ingress.labels['traefik.docker.network'],
    'dokploy-network'
  );

  for (const worker of workers) {
    assert.deepEqual(serviceNetworks(services[worker]), ['webhook-backend']);
  }

  for (const client of clients) {
    assert.equal(
      services[client].environment.REDIS_URL,
      'redis://:ci-only-url-safe-password@webhook-redis:6379'
    );
    assert.equal(
      services[client].depends_on['webhook-redis'].condition,
      'service_healthy'
    );
  }

  assert.ok(config.networks['webhook-backend']);
  assert.ok(config.networks['dokploy-network'].external);
  assert.ok(config.volumes['webhook-redis-data']);
  assert.equal(config.volumes['webhook-redis-data'].name, 'webhook-redis-data');
});
