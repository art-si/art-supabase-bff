import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import tailwind from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withSharedScssGlobals } from './scripts/scss-globals.mjs'
import { createViteWatchPolicy } from './scripts/vite-watch-policy.mjs'
import { getElementPlusStyleDeps } from './scripts/element-plus-style-deps.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  cacheDir: path.resolve(root, 'node_modules/.cache/vite-bff', process.env.BFF_PORT || '3010'),
  define: { __APP_VERSION__: JSON.stringify('1.0.0'), __CLOUDBASE_BUILD__: false },
  resolve: {
    alias: Object.fromEntries(
      Object.entries({
        '@': 'src',
        '@views': 'src/views',
        '@imgs': 'src/assets/images',
        '@icons': 'src/assets/icons',
        '@utils': 'src/utils',
        '@stores': 'src/store',
        '@plugins': 'src/plugins',
        '@styles': 'src/assets/styles'
      }).map(([key, value]) => [key, path.resolve(root, value)])
    )
  },
  plugins: [
    vue(),
    vueJsx(),
    tailwind(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia', '@vueuse/core'],
      viteOptimizeDeps: false,
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/import/auto-imports.d.ts'
    }),
    Components({
      dirs: ['src/components/core', 'src/components/business'],
      extensions: ['vue'],
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/import/components.d.ts'
    })
  ],
  optimizeDeps: {
    entries: ['index.html'],
    exclude: getElementPlusStyleDeps(root),
    include: [
      'vue',
      'vue-router',
      'pinia',
      'pinia-plugin-persistedstate',
      'vue-i18n',
      'element-plus',
      'element-plus/es',
      'element-plus/es/locale/lang/en',
      'element-plus/es/locale/lang/zh-cn',
      '@vueuse/core',
      '@iconify/vue',
      'lodash-es',
      'dayjs',
      'dayjs/plugin/utc',
      'dayjs/plugin/timezone',
      'file-saver',
      'nprogress',
      'crypto-js'
    ]
  },
  css: { preprocessorOptions: { scss: { additionalData: withSharedScssGlobals } } },
  server: {
    watch: createViteWatchPolicy('dist'),
    port: 3011,
    proxy: { '/api': 'http://localhost:3010' }
  },
  build: { chunkSizeWarningLimit: 1500 }
})
