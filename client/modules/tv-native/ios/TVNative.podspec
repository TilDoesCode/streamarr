Pod::Spec.new do |s|
  s.name           = 'TVNative'
  s.version        = '1.0.0'
  s.summary        = 'Streamarr Apple TV focus and Menu'
  s.description    = 'Menu gate, focus requests outside the React Native root view and the tab bar scroll view on tvOS'
  s.author         = 'Streamarr'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
