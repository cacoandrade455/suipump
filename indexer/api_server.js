// api_server.js
// Standalone entry point for the Render web service.
// The indexer (worker) and API (web) run as separate Render services
// sharing the same PostgreSQL database.

import 'dotenv/config';
import { initSchema } from './db.js';
import { startApi } from './api.js';

await initSchema();
startApi();
