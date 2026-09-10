export const IGNORE_PATTERNS = [
  'node_modules',
  '.turbo',
  'dist',
  'dist-ssr',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.cache',
  'tmp',
  'temp',
  '.git',
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
  '.DS_Store',
  '*.log',
  '*.tsbuildinfo',
  '*.tgz',
  '.vscode',
  '.idea',
  '*.swp',
  '*.swo',
  'logs',
  '.pnp',
  '.pnp.js',
  '*.local',
  'bun.lockb',
  ".next",
  "next",
  ".nx",
  "nx",
  "context.json",
];

export function shouldIgnoreFile(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');

    return IGNORE_PATTERNS.some(pattern => {
        if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(normalizedPath);
        }
        return normalizedPath.includes(pattern);
    });
}