import { startWeaviate } from '@onebox/testing';
import { storeContract } from './test/contract';

storeContract('WEAVIATE', startWeaviate);
