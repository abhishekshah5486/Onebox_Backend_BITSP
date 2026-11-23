import { startPinecone } from '@onebox/testing';
import { storeContract } from './test/contract';

// The emulator accepts any key, so only real Pinecone can turn a wrong one down.
storeContract('PINECONE', startPinecone);
