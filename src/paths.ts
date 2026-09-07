// import.meta.dir is Bun-only and import.meta.dirname needs a recent Node, so
// resolve it once here. Works the same from src/*.ts under Bun and from
// dist/*.js under either runtime: the plugin root is always one level up.

import path from "node:path"
import { fileURLToPath } from "node:url"

export const dirOf = (metaUrl: string) => path.dirname(fileURLToPath(metaUrl))

/** The plugin root, from any module that lives one directory below it. */
export const rootFrom = (metaUrl: string) => path.join(dirOf(metaUrl), "..")

/** The runtime shim, which knows how to start bun or node. */
export const shim = (root: string) => path.join(root, "bin", "crosstalk")
