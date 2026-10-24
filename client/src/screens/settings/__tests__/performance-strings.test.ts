import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

describe('performance mode texts', () => {
  it('say that lite mode calms Home and keeps focus and menu animations (de/en)', () => {
    expect(de.settings.performance.hint).toBe(
      'Ruhigere Startseite und sparsamere Effekte für langsamere TV-Boxen. Fokus- und Menüanimationen bleiben.'
    );
    expect(de.settings.performance.stateOn).toBe('An: ruhige Startseite, sparsame Effekte');
    expect(en.settings.performance.hint).toBe(
      'A calmer Home and lighter effects for slower TV boxes. Focus and menu animations stay.'
    );
    expect(en.settings.performance.stateOn).toBe('On: calm Home, light effects');
    for (const text of [de, en].flatMap((locale) => Object.values(locale.settings.performance)))
      expect(String(text)).not.toMatch(/weniger Animationen|fewer animations|reduced animations/i);
  });
});
