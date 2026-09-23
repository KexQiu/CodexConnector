import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { TaskWorker } from '../../src/tasks/worker.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const db = openGatewayDatabase(join(config.dataDir, 'gateway.sqlite'));
const worker = new TaskWorker(new TaskStore(db), config);
await worker.start();
const close = () => {
  worker.close();
  db.close();
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.stdout.write('READY\n');
