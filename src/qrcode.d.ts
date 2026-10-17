/** Optional QR encoder resolved from the profile node_modules when present. */
declare module 'qrcode' {
  export function toString(
    text: string,
    options?: {
      type?: 'svg' | 'utf8' | 'terminal';
      margin?: number;
      width?: number;
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    },
  ): Promise<string>;
  const _default: { toString: typeof toString };
  export default _default;
}
