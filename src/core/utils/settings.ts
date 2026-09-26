/**
 * Lazy settings access for drivers.
 *
 * `vscode` is required lazily so driver modules stay loadable outside the
 * extension host (integration scripts / tests), where the module is absent.
 */
export function driverSetting<T>(name: string, fallback: T): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const value = vscode.workspace?.getConfiguration?.('sqlens')?.get?.(name);
    return coerceSetting(value, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Accept a setting value only when it matches the fallback's shape — this
 * keeps stubbed/odd configuration hosts from leaking non-primitive objects
 * into numeric/boolean code paths.
 */
function coerceSetting<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) { return fallback; }
  if (Array.isArray(fallback)) {
    return Array.isArray(value) ? value as T : fallback;
  }
  const expected = typeof fallback;
  if (expected === 'number' || expected === 'boolean' || expected === 'string') {
    return typeof value === expected ? value as T : fallback;
  }
  return value as T;
}

/** Read a driver setting, preferring an explicit per-connection option. */
export function driverSettingOrOption<T>(
  name: string,
  optionValue: unknown,
  fallback: T,
): T {
  if (optionValue !== undefined && optionValue !== null) {
    return optionValue as T;
  }
  return driverSetting<T>(name, fallback);
}
