Pod::Spec.new do |s|
  s.name           = 'PointerEvents'
  s.version        = '1.0.0'
  s.summary        = 'Streamarr iPad pointer events'
  s.description    = 'Turns on W3C pointer events so the iPad pointer reaches onPointerEnter (hover)'
  s.author         = 'Streamarr'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'React-Core'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
