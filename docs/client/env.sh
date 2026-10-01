# Toolchain environment for Streamarr client + backend work. Usage: source docs/client/env.sh
export DOTNET_ROOT="$HOME/.dotnet"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$HOME/.dotnet:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export EXPO_NO_TELEMETRY=1
export STREAMARR_DEVWORLD_URL="http://127.0.0.1:39300"
# Xcode 27 even while xcode-select still points at the Command Line Tools (argent needs xcode-select itself)
[ -d /Applications/Xcode.app/Contents/Developer ] && export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
