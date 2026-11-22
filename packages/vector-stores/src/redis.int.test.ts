import { startRedis } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('REDIS', async () => {
  const server = await startRedis();
  return { settings: { url: server.url }, stop: server.stop };
});
