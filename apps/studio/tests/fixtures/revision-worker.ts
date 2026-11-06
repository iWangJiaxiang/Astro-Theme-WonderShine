import { LocalRepository } from '../../server/repository.js';
import { DiskRevisionStore } from '../../server/revision-store.js';

const [root, directory, action, revision] = process.argv.slice(2);
const repository = new LocalRepository(root, new DiskRevisionStore(root, { directory }));
try {
  const result = action === 'read' ? await repository.read('config.toml')
    : await repository.write('config.toml', action, revision === 'null' ? null : revision);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { status: (error as { status?: number }).status, message: String(error) } }));
}
