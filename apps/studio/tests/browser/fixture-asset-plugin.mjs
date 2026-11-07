import { readFile } from 'node:fs/promises';

// Vite query imports need explicit semantics in standalone esbuild fixtures.
// This serves real bytes, not production rendering or external SVG <use> acceptance.
export function fixtureAssetPlugin() {
  const namespace = 'studio-fixture-query-asset';
  return {
    name: 'studio-fixture-query-assets',
    setup(builder) {
      builder.onResolve({ filter: /\?(raw|url)$/ }, async args => {
        const separator = args.path.lastIndexOf('?');
        const request = args.path.slice(0, separator);
        const mode = args.path.slice(separator + 1);
        const resolved = await builder.resolve(request, {
          importer: args.importer, resolveDir: args.resolveDir,
          kind: args.kind, namespace: args.namespace,
        });
        if (resolved.errors.length) return { errors: resolved.errors, warnings: resolved.warnings };
        if (resolved.external || resolved.namespace !== 'file' || !resolved.path) {
          return { errors: [{ text: 'Fixture query asset must resolve to a real local file' }] };
        }
        // The same SVG can be imported both ways; distinct namespaces prevent
        // esbuild's module cache from conflating its raw text and URL exports.
        return { path: resolved.path, namespace: `${namespace}-${mode}`, warnings: resolved.warnings };
      });
      for (const mode of ['raw', 'url']) {
        builder.onLoad({ filter: /.*/, namespace: `${namespace}-${mode}` }, async ({ path }) => ({
          contents: await readFile(path, mode === 'raw' ? 'utf8' : undefined),
          loader: mode === 'raw' ? 'text' : 'dataurl',
          watchFiles: [path],
        }));
      }
    },
  };
}
