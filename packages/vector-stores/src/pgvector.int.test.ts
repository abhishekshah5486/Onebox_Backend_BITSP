import { startPgvector } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('PGVECTOR', startPgvector, {
  badSettings: (settings) => ({
    ...settings,
    connectionString: settings.connectionString!.replace(/:[^:@]+@/, ':wrong@'),
  }),
});
