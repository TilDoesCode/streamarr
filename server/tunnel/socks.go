package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// dialFunc opens a TCP connection inside the tunnel; the address may carry a domain name, which the
// netstack resolves through the tunnel's DNS servers only.
type dialFunc func(ctx context.Context, network, address string) (net.Conn, error)

const (
	socksVersion       = 0x05
	socksNoAuth        = 0x00
	socksNoAcceptable  = 0xFF
	socksCmdConnect    = 0x01
	socksAtypIPv4      = 0x01
	socksAtypDomain    = 0x03
	socksAtypIPv6      = 0x04
	socksRepSuccess    = 0x00
	socksRepFailure    = 0x01
	socksRepNetUnreach = 0x03
	socksRepHostUnr    = 0x04
	socksRepRefused    = 0x05
	socksRepCmdUnsupp  = 0x07
	socksRepAtypUnsupp = 0x08

	socksHandshakeTimeout = 10 * time.Second
	socksDialTimeout      = 30 * time.Second
)

// socksServer accepts loopback SOCKS5 clients and relays CONNECT sessions into the tunnel.
type socksServer struct {
	ln   net.Listener
	dial dialFunc
	log  *logger
	wg   sync.WaitGroup
}

func newSocksServer(ln net.Listener, dial dialFunc, log *logger) *socksServer {
	return &socksServer{ln: ln, dial: dial, log: log}
}

func (s *socksServer) serve(ctx context.Context) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			s.log.Warn("socks accept failed", "error", err.Error())
			time.Sleep(50 * time.Millisecond)
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(ctx, conn)
		}()
	}
}

func (s *socksServer) close() {
	_ = s.ln.Close()
	s.wg.Wait()
}

func (s *socksServer) handle(ctx context.Context, client net.Conn) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(socksHandshakeTimeout))
	target, err := socksHandshake(client)
	if err != nil {
		s.log.Debug("socks handshake rejected", "error", err.Error())
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, socksDialTimeout)
	upstream, err := s.dial(dialCtx, "tcp", target)
	cancel()
	if err != nil {
		s.log.Debug("socks connect failed", "target", target, "error", err.Error())
		_ = writeSocksReply(client, socksReplyFor(err))
		return
	}
	defer upstream.Close()
	if err := writeSocksReply(client, socksRepSuccess); err != nil {
		return
	}
	_ = client.SetDeadline(time.Time{})
	relay(client, upstream)
}

// socksHandshake negotiates "no authentication" and reads one CONNECT request, returning host:port.
// A failed negotiation or an unsupported request is answered on the wire before the error returns.
func socksHandshake(c net.Conn) (string, error) {
	var head [2]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return "", fmt.Errorf("greeting: %w", err)
	}
	if head[0] != socksVersion {
		return "", fmt.Errorf("unsupported SOCKS version %d", head[0])
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return "", fmt.Errorf("greeting methods: %w", err)
	}
	accepted := false
	for _, m := range methods {
		if m == socksNoAuth {
			accepted = true
			break
		}
	}
	if !accepted {
		_, _ = c.Write([]byte{socksVersion, socksNoAcceptable})
		return "", errors.New("client offers no acceptable authentication method")
	}
	if _, err := c.Write([]byte{socksVersion, socksNoAuth}); err != nil {
		return "", err
	}

	var req [4]byte
	if _, err := io.ReadFull(c, req[:]); err != nil {
		return "", fmt.Errorf("request: %w", err)
	}
	if req[0] != socksVersion {
		return "", fmt.Errorf("unsupported request version %d", req[0])
	}
	if req[1] != socksCmdConnect {
		_ = writeSocksReply(c, socksRepCmdUnsupp)
		return "", fmt.Errorf("unsupported command %d", req[1])
	}
	var host string
	switch req[3] {
	case socksAtypIPv4:
		var a [4]byte
		if _, err := io.ReadFull(c, a[:]); err != nil {
			return "", err
		}
		host = netip.AddrFrom4(a).String()
	case socksAtypIPv6:
		var a [16]byte
		if _, err := io.ReadFull(c, a[:]); err != nil {
			return "", err
		}
		host = netip.AddrFrom16(a).String()
	case socksAtypDomain:
		var n [1]byte
		if _, err := io.ReadFull(c, n[:]); err != nil {
			return "", err
		}
		name := make([]byte, int(n[0]))
		if _, err := io.ReadFull(c, name); err != nil {
			return "", err
		}
		host = string(name)
		if host == "" {
			_ = writeSocksReply(c, socksRepAtypUnsupp)
			return "", errors.New("empty domain name")
		}
	default:
		_ = writeSocksReply(c, socksRepAtypUnsupp)
		return "", fmt.Errorf("unsupported address type %d", req[3])
	}
	var p [2]byte
	if _, err := io.ReadFull(c, p[:]); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(p[:])
	return net.JoinHostPort(host, strconv.Itoa(int(port))), nil
}

// writeSocksReply sends a reply with a zero bind address, which every mainstream client accepts.
func writeSocksReply(c net.Conn, rep byte) error {
	_, err := c.Write([]byte{socksVersion, rep, 0x00, socksAtypIPv4, 0, 0, 0, 0, 0, 0})
	return err
}

func socksReplyFor(err error) byte {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return socksRepRefused
	case errors.Is(err, syscall.ENETUNREACH):
		return socksRepNetUnreach
	case errors.Is(err, syscall.EHOSTUNREACH), isLookupError(err):
		return socksRepHostUnr
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "refused"):
		return socksRepRefused
	case strings.Contains(msg, "unreachable"), strings.Contains(msg, "no such host"), strings.Contains(msg, "lookup"), strings.Contains(msg, "dns"):
		return socksRepHostUnr
	}
	return socksRepFailure
}

func isLookupError(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

// relay copies both directions and returns when either side closes.
func relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	pump := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.SetReadDeadline(time.Now().Add(time.Second))
		}
		done <- struct{}{}
	}
	go pump(a, b)
	go pump(b, a)
	<-done
	<-done
}
