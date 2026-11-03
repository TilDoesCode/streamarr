package main

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

// logger writes one JSON object per line; the server keeps the last error line as the tunnel's lastError.
type logger struct {
	mu      sync.Mutex
	w       io.Writer
	verbose bool
}

func newLogger(w io.Writer, verbose bool) *logger { return &logger{w: w, verbose: verbose} }

func (l *logger) write(level, msg string, kv []any) {
	rec := make(map[string]any, 3+len(kv)/2)
	rec["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	rec["level"] = level
	rec["msg"] = msg
	for i := 0; i+1 < len(kv); i += 2 {
		if k, ok := kv[i].(string); ok {
			rec[k] = kv[i+1]
		}
	}
	line, err := json.Marshal(rec)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(append(line, '\n'))
}

func (l *logger) Debug(msg string, kv ...any) {
	if l.verbose {
		l.write("debug", msg, kv)
	}
}
func (l *logger) Info(msg string, kv ...any)  { l.write("info", msg, kv) }
func (l *logger) Warn(msg string, kv ...any)  { l.write("warn", msg, kv) }
func (l *logger) Error(msg string, kv ...any) { l.write("error", msg, kv) }
