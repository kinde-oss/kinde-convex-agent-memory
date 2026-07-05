import {defineApp} from 'convex/server';
import memory from '@kinde-oss/kinde-convex-agent-memory/convex.config.js';

const app = defineApp();

app.use(memory);

export default app;
