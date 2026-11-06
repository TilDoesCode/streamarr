Pod::Spec.new do |s|
  s.name           = 'OfflineDownloads'
  s.version        = '1.0.0'
  s.summary        = 'Streamarr offline downloads'
  s.description    = 'Background URLSession download queue with resume data, Wi-Fi only and app-private storage'
  s.author         = 'Streamarr'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "Tests/**/*"
end
