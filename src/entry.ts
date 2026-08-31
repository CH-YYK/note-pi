import { Platform } from "obsidian";
import type NotePiPlugin from "./main";
import type NotePiMobilePlugin from "./mobile/main";

declare function require(id: string): { default: typeof NotePiPlugin } | { default: typeof NotePiMobilePlugin };

/**
 * Universal plugin entry point. Obsidian always loads main.js, on every
 * platform, so the desktop and mobile runtimes are separate module trees
 * selected here at load time. Both branches go through require() so the
 * unselected tree's module scope — including the desktop tree's Node
 * imports — never evaluates on the other platform.
 *
 * The dispatch key is Platform.isMobile ("the UI is in mobile mode"), not
 * isMobileApp: isMobileApp stays false under Obsidian's mobile emulation,
 * while isMobile is true there, so the mobile runtime is what developers
 * get when validating the plugin with emulation on a desktop host.
 */
const pluginClass = Platform.isMobile
  ? require("./mobile/main").default
  : require("./main").default;

export default pluginClass;
