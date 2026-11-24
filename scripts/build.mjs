import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
await fs.mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/cli.mjs'], outfile: 'dist/speed-mcp.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true, legalComments: 'linked', banner: { js: 'import { createRequire as __speedRequire } from "node:module"; const require = __speedRequire(import.meta.url);' } });
// Include full dependency license texts, including transitives, for redistribution.
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const licenses = [];
for (const [dir, info] of Object.entries(lock.packages)) {
  if (!dir || info.dev || info.optional) continue;
  const files = await fs.readdir(dir).catch(() => []);
  const licenseFile = files.find(f => /^licen[cs]e(?:\.md|\.txt)?$/i.test(f));
  if (licenseFile) licenses.push(`\n--- ${dir} ${info.version} ---\n${await fs.readFile(`${dir}/${licenseFile}`, 'utf8')}`);
}
await fs.writeFile('dist/THIRD-PARTY-LICENSES.txt', licenses.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
await fs.writeFile('dist/version.json', JSON.stringify({ version: pkg.version, node: pkg.engines.node }) + '\n');
