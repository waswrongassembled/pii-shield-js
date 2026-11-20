import {
  EncryptedVault,
  EntityLearner,
  generateVaultKey,
  InMemoryCustomEntityStore,
  MemoryVaultStorage,
  ModelDetector,
  ModelLocation,
} from '../../src/index.js';
import { ServiceApi, type ServiceApiOptions } from '../../src/server/index.js';

export const TOKEN = 'test-token-0123456789';

/** A fake model that always finds this person. Never calls a provider. */
export function fakeModelDetector(answer = '{"entities":[{"type":"PERSON","value":"Johann Beispielmann"}]}') {
  return () =>
    new ModelDetector({
      model: { name: 'test-model', generate: () => Promise.resolve(answer) },
      location: ModelLocation.Local,
    });
}

/** A ServiceApi over in-memory stores (fresh key and vault each time). */
export function serviceApi(options: Partial<ServiceApiOptions> = {}): ServiceApi {
  return new ServiceApi({
    vault: new EncryptedVault({ storage: new MemoryVaultStorage(), key: generateVaultKey() }),
    learner: new EntityLearner({ store: new InMemoryCustomEntityStore() }),
    token: TOKEN,
    ...options,
  });
}
