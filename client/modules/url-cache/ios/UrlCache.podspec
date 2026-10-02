Pod::Spec.new do |s|
  s.name           = 'UrlCache'
  s.version        = '1.0.0'
  s.summary        = 'Streamarr: no NSURLCache for API traffic'
  s.description    = 'Session configuration without URLCache for React Native networking and expo/fetch'
  s.author         = 'Streamarr'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'React-Core'

  s.source_files = "**/*.{h,m}"
end
