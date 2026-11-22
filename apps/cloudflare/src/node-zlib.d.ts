// Minimal typing for the one node:zlib function the Worker uses (enabled by
// the nodejs_compat flag in wrangler.jsonc; implemented natively by workerd).
declare module "node:zlib" {
  export function crc32(data: string | ArrayBufferView, value?: number): number;
}
