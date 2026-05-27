// api_server.js
import 'dotenv/config';
import { initSchema, backfillAllMetadataObjects } from './db.js';
import { startApi } from './api.js';

await initSchema();
backfillAllMetadataObjects().catch(() => {}); // populate metadata ISV for existing tokens
startApi();
