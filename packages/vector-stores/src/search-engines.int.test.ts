import { startElasticsearch } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('ELASTICSEARCH', async () => {
  const server = await startElasticsearch();
  return { settings: { url: server.url }, stop: server.stop };
});
