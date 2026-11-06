import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** Reuse pro's style-entry exclusion for both CSS and Sass resolver modes. */
export function getElementPlusStyleDeps(root) {
  const componentsDir = path.resolve(root, 'node_modules/element-plus/es/components')
  if (!existsSync(componentsDir)) return []
  return readdirSync(componentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ['css', 'index']
        .filter((style) =>
          existsSync(path.join(componentsDir, entry.name, 'style', `${style}.mjs`))
        )
        .map((style) => `element-plus/es/components/${entry.name}/style/${style}`)
    )
    .sort()
}
