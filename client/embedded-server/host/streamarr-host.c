// Launches the self-contained Streamarr.Server from the app's data directory: Android 10+ only execs files in the APK's
// native library directory, and the stock apphost insists on finding the app next to its own executable.
#include <dlfcn.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "hostfxr.h"

static void* must_sym(void* lib, const char* name) {
  void* fn = dlsym(lib, name);
  if (!fn) {
    fprintf(stderr, "streamarr-host: %s missing in libhostfxr.so\n", name);
    exit(67);
  }
  return fn;
}

// Boxes whose linker namespace hides the system ICU get invariant globalization instead of a crash at startup.
static void probe_icu(void) {
  if (getenv("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT")) return;
  void* uc = dlopen("libicuuc.so", RTLD_LAZY);
  void* i18n = uc ? dlopen("libicui18n.so", RTLD_LAZY) : NULL;
  if (uc && i18n) return;
  fprintf(stderr, "streamarr-host: system ICU unavailable (%s); using invariant globalization\n", dlerror());
  setenv("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT", "1", 1);
  setenv("DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY", "0", 1);
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <Streamarr.Server.dll> [args...]\n", argv[0]);
    return 64;
  }
  static char app[PATH_MAX], dir[PATH_MAX], fxr[PATH_MAX], self[PATH_MAX];
  if (!realpath(argv[1], app)) {
    perror("streamarr-host: app path");
    return 65;
  }
  strncpy(dir, app, sizeof dir - 1);
  char* slash = strrchr(dir, '/');
  if (slash) *slash = '\0';
  snprintf(fxr, sizeof fxr, "%s/libhostfxr.so", dir);
  ssize_t len = readlink("/proc/self/exe", self, sizeof self - 1);
  self[len > 0 ? len : 0] = '\0';

  probe_icu();
  void* lib = dlopen(fxr, RTLD_LAZY | RTLD_GLOBAL);
  if (!lib) {
    fprintf(stderr, "streamarr-host: %s\n", dlerror());
    return 66;
  }
  hostfxr_initialize_for_dotnet_command_line_fn init = must_sym(lib, "hostfxr_initialize_for_dotnet_command_line");
  hostfxr_run_app_fn run = must_sym(lib, "hostfxr_run_app");
  hostfxr_close_fn close_handle = must_sym(lib, "hostfxr_close");

  // dotnet_root = the app directory: hostfxr then runs in self-contained mode (libcoreclr.so and deps.json live there).
  struct hostfxr_initialize_parameters params = { sizeof params, self, dir };
  argv[1] = app;
  hostfxr_handle handle = NULL;
  int rc = init(argc - 1, (const char**)argv + 1, &params, &handle);
  if (rc != 0 || !handle) {
    fprintf(stderr, "streamarr-host: hostfxr initialization failed (0x%x)\n", rc);
    return 68;
  }
  rc = run(handle);
  close_handle(handle);
  return rc;
}
