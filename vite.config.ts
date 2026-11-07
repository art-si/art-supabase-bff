import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig, loadEnv, type AliasOptions } from 'vite'

const applicationRoot = fileURLToPath(new URL('.', import.meta.url))
const platformRoot = realpathSync(path.join(applicationRoot, 'node_modules/art-supabase-pro'))
if (process.argv.includes('--typecheck')) {
  const { typecheckModule } = await import(
    pathToFileURL(path.join(platformRoot, 'scripts/module-typecheck.mjs')).href
  )
  process.exitCode = typecheckModule({ applicationRoot, platformRoot })
}

export default defineConfig(async ({ mode }) => {
  const bffEnv = loadEnv(mode, applicationRoot, 'BFF_')
  const viteEnv = loadEnv(mode, applicationRoot, 'VITE_')
  const { createModuleViteConfig } = await import(
    pathToFileURL(path.join(platformRoot, 'scripts/module-vite-config.mjs')).href
  )
  const config = await createModuleViteConfig({
    appCode: 'bff',
    applicationRoot,
    defaultPort: Number(process.env.BFF_PORT || bffEnv.BFF_PORT || 3010),
    mode,
    platformRoot,
    inheritPlatformEnv: false,
    authSessionMode: 'server'
  })
  const aliases = config.resolve?.alias as Record<string, string>
  const alias: AliasOptions = [
    {
      find: /^@\/api\/system-manage\/website-config$/,
      replacement: path.join(applicationRoot, 'src/api/website-config.ts')
    },
    ...[
      'system-manage',
      'data-center',
      'attachments',
      'unique-field',
      'master-data-delete',
      'table-column-config',
      'unit-of-measure'
    ].map((name) => ({
      find: new RegExp(`^@/api/${name}$`),
      replacement: path.join(applicationRoot, `src/api/${name}.ts`)
    })),
    {
      find: /^@\/router(?:\/index)?$/,
      replacement: path.join(applicationRoot, 'src/router/index.ts')
    },
    ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
  ]
  return {
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      exclude: [...(config.optimizeDeps?.exclude ?? []), 'art-supabase-pro']
    },
    resolve: { ...config.resolve, alias },
    build: { ...config.build, outDir: process.env.VITE_OUT_DIR || viteEnv.VITE_OUT_DIR || 'docs' }
  }
})
