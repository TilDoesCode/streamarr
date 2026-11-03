package main

import (
	"context"
	"errors"
	"net"
	"time"

	"golang.zx2c4.com/wireguard/tun/netstack"
)

// forwardListener accepts TCP inside the tunnel and pipes each connection to a host target.
type forwardListener struct {
	ln  net.Listener
	f   forward
	log *logger
}

func newForwardListener(tnet *netstack.Net, f forward, log *logger) (*forwardListener, error) {
	ln, err := tnet.ListenTCPAddrPort(f.listen)
	if err != nil {
		return nil, fieldErr("forwards", "listen %s: %v", f.listen, err)
	}
	return &forwardListener{ln: ln, f: f, log: log}, nil
}

func (l *forwardListener) serve(ctx context.Context) {
	for {
		c, err := l.ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			l.log.Warn("forward accept failed", "listen", l.f.listen.String(), "error", err.Error())
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go func() {
			defer c.Close()
			dialer := net.Dialer{Timeout: 10 * time.Second}
			up, err := dialer.DialContext(ctx, "tcp", l.f.target)
			if err != nil {
				l.log.Warn("forward dial failed", "target", l.f.target, "error", err.Error())
				return
			}
			defer up.Close()
			relay(c, up)
		}()
	}
}

func (l *forwardListener) close() { _ = l.ln.Close() }
