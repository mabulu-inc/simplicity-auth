import { it } from 'vitest';
import pg from 'pg';
import { startTestDb } from './helpers/test-db.js';

// Models a loaded CI runner: a pool's connections take a moment to tell the
// server they're leaving, so their backends are still alive when shutdown()
// reaches them.
it('shuts down cleanly while a closed pool is still disconnecting', async () => {
  const db = await startTestDb();
  const extra = new pg.Pool({ connectionString: db.appPrivilegedConnectionString, max: 2 });
  extra.on('connect', (client) => {
    const connection = (client as unknown as { connection: { end: () => void } }).connection;
    const end = connection.end.bind(connection);
    connection.end = () => void setTimeout(end, 200);
  });
  await Promise.all([extra.query('SELECT 1'), extra.query('SELECT 1')]);
  await extra.end();
  await db.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 400));
}, 60_000);
