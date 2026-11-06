import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig, type AliasOptions } from 'vite'

const applicationRoot = fileURLToPath(new URL('.', import.meta.url))
// Explicit override supports joint development; normal installs always use the npm package.
const platformRoot = realpathSync(
  process.env.ART_SUPABASE_PLATFORM_ROOT ||
    path.join(applicationRoot, 'node_modules/art-supabase-pro')
)
if (process.argv.includes('--typecheck')) {
  const { typecheckModule } = await import(
    pathToFileURL(path.join(platformRoot, 'scripts/module-typecheck.mjs')).href
  )
  process.exitCode = typecheckModule({ applicationRoot, platformRoot })
}

export default defineConfig(async ({ mode }) => {
  const { createModuleViteConfig } = await import(
    pathToFileURL(path.join(platformRoot, 'scripts/module-vite-config.mjs')).href
  )
  const config = await createModuleViteConfig({
    appCode: 'bff',
    applicationRoot,
    defaultPort: Number(process.env.BFF_PORT || 3010),
    mode,
    platformRoot,
    inheritPlatformEnv: false,
    authSessionMode: 'server'
  })
  const aliases = config.resolve?.alias as Record<string, string>
  const alias: AliasOptions = [
    {
      find: /^@\/router(?:\/index)?$/,
      replacement: path.join(applicationRoot, 'src/router/index.ts')
    },
    ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
  ]
  return {
    ...config,
    resolve: { ...config.resolve, alias },
    build: { ...config.build, outDir: 'dist' }
  }
})
