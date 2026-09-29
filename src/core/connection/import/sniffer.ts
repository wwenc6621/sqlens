/**
 * Sniffer-side helpers shared between the pipeline and UI code.
 */

export interface GridParseOptions {
  delimiter: '\t' | ',' | ';';
  hasHeader: boolean;
}

/** Decide grid parameters from raw text (called once before parsing). */
export function gridParseOptionsFromText(text: string): GridParseOptions {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter: GridParseOptions['delimiter'] = firstLine.includes('\t')
    ? '\t'
    : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  return { delimiter, hasHeader: true };
}
