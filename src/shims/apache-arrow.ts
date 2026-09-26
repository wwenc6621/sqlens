/**
 * Build-time stub for `apache-arrow/Arrow.node`.
 *
 * `@elastic/elasticsearch`'s helpers module requires the optional Apache Arrow
 * binding at load time (used only by its ES|QL helpers). The package does not
 * ship `Arrow.node`, so a plain bundle would throw MODULE_NOT_FOUND while the
 * extension loads. The bundler aliases that specifier to this empty module;
 * the Arrow-backed ES|QL helpers are never called by Sqlens.
 */
export default {};
export const Table = undefined;
export const tableFromIPC = undefined;
export const tableToIPC = undefined;
