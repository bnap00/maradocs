import { build } from 'esbuild'
import { readFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8')
)

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire } from 'module';",
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { __VERSION__: JSON.stringify(version) },
})

chmodSync('dist/index.js', 0o755)
console.log(`built dist/index.js  (v${version})`)
