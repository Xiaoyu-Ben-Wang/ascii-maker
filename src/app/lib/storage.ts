export const KEYS = {
  look: 'ascii-maker:v2', presets: 'ascii-maker:presets', gpu: 'ascii-maker:gpu', clipboard: 'ascii-maker:clipboard', movedKeys: 'ascii-maker:moved-keys',
} as const;

export function load<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
