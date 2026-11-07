import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../../..');
const rules = join(root, 'node_modules/expo-secure-store/android/src/main/res/xml');

// Downloads live in files/downloads: Auto Backup must not pick up multi-GB files (include-only rules keep `file` out).
describe('Android backup rules keep downloads out', () => {
  it('keeps expo-secure-store backup rules on in app.config.ts', () => {
    const config = readFileSync(join(root, 'app.config.ts'), 'utf8');
    expect(config).toMatch(/'expo-secure-store',\s*\{[^}]*configureAndroidBackup:\s*true/);
  });

  it.each(['secure_store_backup_rules.xml', 'secure_store_data_extraction_rules.xml'])(
    '%s only includes shared preferences',
    (file) => {
      const xml = readFileSync(join(rules, file), 'utf8');
      const includes = [...xml.matchAll(/<include domain="([^"]+)"/g)].map((match) => match[1]);
      expect(includes.length).toBeGreaterThan(0);
      expect(new Set(includes)).toEqual(new Set(['sharedpref']));
    }
  );
});
