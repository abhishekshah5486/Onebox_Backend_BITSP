import { startNeo4j } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('NEO4J', startNeo4j, {
  badSettings: (settings) => ({ ...settings, password: 'wrong' }),
});
