// Build-time settings (scripts/build.mjs). A release build signs for mainnet only and
// lists the official origins; a devnet build bakes in the local chain's parameters.

import type { NetworkParams } from "../../web/src/lib/types";

declare const __OMAVOTE_FLAVOR__: "release" | "devnet";
declare const __OMAVOTE_NETWORK__: NetworkParams | null;
declare const __OMAVOTE_OFFICIAL__: string[];

export const FLAVOR = __OMAVOTE_FLAVOR__;
/** null: the core's built-in mainnet parameters. */
export const NETWORK = __OMAVOTE_NETWORK__;
export const OFFICIAL_PATTERNS = __OMAVOTE_OFFICIAL__;
