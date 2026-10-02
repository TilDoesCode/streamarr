import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '../../modules/url-cache');
const read = (file: string) => readFileSync(join(dir, file), 'utf8');

describe('url-cache native module', () => {
  it('is autolinked for Apple platforms only and builds for iOS and tvOS', () => {
    expect(JSON.parse(read('expo-module.config.json')).platforms).toEqual(['apple']);
    const podspec = read('ios/UrlCache.podspec');
    expect(podspec).toMatch(/:ios\s*=>/);
    expect(podspec).toMatch(/:tvos\s*=>/);
  });

  it('gives RN networking and expo/fetch a session without URLCache', () => {
    const source = read('ios/STRUrlCache.m');
    expect(source).toContain('configuration.URLCache = nil');
    expect(source).toContain('NSURLRequestReloadIgnoringLocalCacheData');
    expect(source).toContain('RCTSetCustomNSURLSessionConfigurationProvider(provider)');
    expect(source).toContain('EXFetchCustomExtension');
    expect(source).toContain('removeAllCachedResponses');
    expect(source).toContain('initWithMemoryCapacity:0 diskCapacity:0');
  });
});
