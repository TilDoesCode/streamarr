// Android: ReactViewManager (react-native-tvos, prebuilt) asks system_server for the enabled a11y services after every view update.
const { createRunOncePlugin, withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// streamarr-a11y-service-cache';

const INSTRUMENTATION = (TARGET_CLASS) => `
${MARKER}: route ReactViewManager's getEnabledAccessibilityServiceList to expo.modules.hostsystem.A11yServiceCache
abstract class StreamarrA11yCacheFactory implements com.android.build.api.instrumentation.AsmClassVisitorFactory<com.android.build.api.instrumentation.InstrumentationParameters.None> {
  @Override
  org.objectweb.asm.ClassVisitor createClassVisitor(com.android.build.api.instrumentation.ClassContext context, org.objectweb.asm.ClassVisitor next) {
    return new org.objectweb.asm.ClassVisitor(org.objectweb.asm.Opcodes.ASM9, next) {
      boolean routed = false

      @Override
      void visitEnd() {
        if (!routed) throw new GradleException('streamarr-a11y-service-cache: ReactViewManager no longer calls getEnabledAccessibilityServiceList; drop or update plugins/with-a11y-service-cache.js')
        super.visitEnd()
      }

      @Override
      org.objectweb.asm.MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
        return new org.objectweb.asm.MethodVisitor(org.objectweb.asm.Opcodes.ASM9, super.visitMethod(access, name, desc, signature, exceptions)) {
          @Override
          void visitMethodInsn(int opcode, String owner, String method, String descriptor, boolean isInterface) {
            if (owner == 'android/view/accessibility/AccessibilityManager' && method == 'getEnabledAccessibilityServiceList') {
              routed = true
              super.visitMethodInsn(org.objectweb.asm.Opcodes.INVOKESTATIC, 'expo/modules/hostsystem/A11yServiceCache', 'enabledList', '(Landroid/view/accessibility/AccessibilityManager;I)Ljava/util/List;', false)
            } else {
              super.visitMethodInsn(opcode, owner, method, descriptor, isInterface)
            }
          }
        }
      }
    }
  }

  @Override
  boolean isInstrumentable(com.android.build.api.instrumentation.ClassData classData) {
    return classData.className == '${TARGET_CLASS}'
  }
}

androidComponents {
  onVariants(selector().all()) { variant ->
    variant.instrumentation.transformClassesWith(StreamarrA11yCacheFactory, com.android.build.api.instrumentation.InstrumentationScope.ALL) {}
  }
}
`;

const TARGET_CLASS = 'com.facebook.react.views.view.ReactViewManager';

const withA11yServiceCache = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(MARKER))
      mod.modResults.contents += INSTRUMENTATION(TARGET_CLASS);
    return mod;
  });

module.exports = createRunOncePlugin(
  withA11yServiceCache,
  'streamarr-with-a11y-service-cache',
  '1.0.0'
);
module.exports.MARKER = MARKER;
module.exports.TARGET_CLASS = TARGET_CLASS;
module.exports.INSTRUMENTATION = INSTRUMENTATION;
