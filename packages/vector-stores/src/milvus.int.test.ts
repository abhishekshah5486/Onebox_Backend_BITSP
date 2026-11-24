import { startMilvus } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('MILVUS', startMilvus);
