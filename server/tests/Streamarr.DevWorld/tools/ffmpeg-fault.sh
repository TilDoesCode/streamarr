#!/bin/sh
# Dev World ffmpeg wrapper (fault injection H5): records its pid, optionally adds -readrate, then execs the real ffmpeg.
real="${DEVWORLD_FFMPEG:-ffmpeg}"
state="${DEVWORLD_FAULT_STATE:-}"
if [ -z "$state" ] || [ ! -d "$state" ]; then
  exec "$real" "$@"
fi
rate=""
case " $* " in *" -progress "*) session=1 ;; *) session="" ;; esac
for f in "$state"/ffmpeg-faults/*; do
  [ -n "$session" ] || break
  [ -f "$f" ] || continue
  key="${f##*/}"
  case " $* " in
    *"$key"*)
      read -r rate mode < "$f"
      [ "$mode" = "always" ] || rm -f "$f"
      break ;;
  esac
done
if [ -n "$rate" ]; then
  done=""
  for a do
    shift
    if [ "$a" = "-i" ] && [ -z "$done" ]; then
      set -- "$@" -readrate "$rate"
      done=1
    fi
    set -- "$@" "$a"
  done
fi
for p in "$state"/ffmpeg-pids/*; do
  [ -f "$p" ] && ! kill -0 "${p##*/}" 2>/dev/null && rm -f "$p"
done
printf '%s\n' "$*" > "$state/ffmpeg-pids/$$" 2>/dev/null
exec "$real" "$@"
