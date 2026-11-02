package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

// Exit codes the supervisor distinguishes.
const (
	exitOK       = 0
	exitConfig   = 2
	exitStart    = 3
	exitInternal = 4
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("streamarr-tunnel", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print the version and exit")
	validateOnly := fs.Bool("validate", false, "read the config from stdin, validate it and exit")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	if *showVersion {
		fmt.Fprintln(stdout, "streamarr-tunnel "+version)
		return exitOK
	}

	cfg, err := ReadConfig(stdin)
	if err != nil {
		newLogger(stderr, false).Error("invalid config", "error", err.Error())
		return exitConfig
	}
	log := newLogger(stderr, cfg.LogLevel == "verbose")
	res, err := cfg.Resolve()
	if err != nil {
		var fe *FieldError
		if errors.As(err, &fe) {
			log.Error("invalid config", "field", fe.Field, "error", fe.Msg)
		} else {
			log.Error("invalid config", "error", err.Error())
		}
		return exitConfig
	}
	if *validateOnly {
		return exitOK
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	t, err := Start(ctx, res, log)
	if err != nil {
		log.Error("tunnel start failed", "error", err.Error())
		return exitStart
	}
	defer t.Close()
	ready := map[string]any{"event": "ready", "socksPort": t.SocksPort(), "statusPort": t.StatusPort(), "endpoint": t.endpoint}
	line, _ := json.Marshal(ready)
	fmt.Fprintln(stdout, string(line))
	log.Info("tunnel started", "endpoint", t.endpoint, "socksPort", t.SocksPort(), "statusPort", t.StatusPort(), "mtu", res.mtu)

	// The parent closing stdin is the portable shutdown signal (no signals needed on Windows).
	stdinClosed := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, stdin)
		close(stdinClosed)
	}()

	select {
	case <-ctx.Done():
		log.Info("tunnel stopping", "reason", "signal")
	case <-stdinClosed:
		log.Info("tunnel stopping", "reason", "stdin closed")
	case <-t.Done():
		log.Error("tunnel stopped unexpectedly")
		return exitInternal
	}
	return exitOK
}
