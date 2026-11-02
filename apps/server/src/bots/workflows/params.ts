/** Params as one comparable string: keys sorted, so the same params in any order compare equal. */
export const canonicalParams = (params: { readonly [name: string]: unknown }): string =>
  JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
