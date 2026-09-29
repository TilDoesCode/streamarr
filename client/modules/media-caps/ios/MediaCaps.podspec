Pod::Spec.new do |s|
  s.name           = 'MediaCaps'
  s.version        = '1.0.0'
  s.summary        = 'Streamarr device media capabilities'
  s.description    = 'VideoToolbox, AVPlayer HDR and audio route capabilities for the Streamarr device profile'
  s.author         = 'Streamarr'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'VideoToolbox', 'CoreMedia'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
