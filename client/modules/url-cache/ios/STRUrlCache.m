#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <React/RCTHTTPRequestHandler.h>

// API responses (sign-in tokens included) must never land in Library/Caches/<bundle>/Cache.db.
static NSURLSessionConfiguration *STRUncachedConfiguration(void)
{
  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
  NSNumber *wifiOnly = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"ReactNetworkForceWifiOnly"];
  if (wifiOnly != nil) {
    configuration.allowsCellularAccess = ![wifiOnly boolValue];
  }
  configuration.HTTPShouldSetCookies = YES;
  configuration.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyAlways;
  configuration.HTTPCookieStorage = [NSHTTPCookieStorage sharedHTTPCookieStorage];
  configuration.URLCache = nil;
  configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  return configuration;
}

@interface STRUrlCache : NSObject
@end

@implementation STRUrlCache

+ (void)load
{
  NSURLSessionConfiguration * (^provider)(void) = ^NSURLSessionConfiguration * {
    return STRUncachedConfiguration();
  };
  RCTSetCustomNSURLSessionConfigurationProvider(provider);

  Class expoFetch = NSClassFromString(@"EXFetchCustomExtension");
  SEL setter = NSSelectorFromString(@"setCustomURLSessionConfigurationProvider:");
  if ([expoFetch respondsToSelector:setter]) {
    ((void (*)(id, SEL, id))objc_msgSend)(expoFetch, setter, provider);
  }

  // Purge what older builds stored, then leave every default session (e.g. the dev network inspector) without a cache.
  [[NSURLCache sharedURLCache] removeAllCachedResponses];
  NSURLCache.sharedURLCache = [[NSURLCache alloc] initWithMemoryCapacity:0 diskCapacity:0 directoryURL:nil];
}

@end
