import { Plugin } from "@opencode/plugin"
import legacyPlugin from "./v1.ts"
import { setupV2 } from "./v2.ts"

// One package, two deliberately separate runtime adapters:
// - OpenCode V2 validates and calls id + setup().
// - OpenCode V1 >= 1.18.29 detects and calls server().
//
// The adapters share the same core/store modules and therefore the same v1.6
// data model. The V2 shape does not attempt to translate V1 hooks at runtime.
export default {
  ...Plugin.define({
    id: "cioffi.opencode-memory",
    setup: setupV2,
  }),
  server: legacyPlugin,
}
