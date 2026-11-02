package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Tunnel is one running WireGuard interface (netstack, no TUN device) with its SOCKS5 proxy, status
// server, optional forwards and optional DNS responder.
type Tunnel struct {
	cfg       *resolved
	log       *logger
	dev       *device.Device
	tnet      *netstack.Net
	startedAt time.Time
	endpoint  string

	socks     *socksServer
	status    *statusServer
	forwards  []*forwardListener
	dnsServer *dnsResponder

	mu       sync.Mutex
	lastErr  string
	closed   bool
	cancel   context.CancelFunc
	finished chan struct{}
}

// Start brings the device up and starts every listener. It returns once the SOCKS and status ports accept.
func Start(ctx context.Context, cfg *resolved, log *logger) (*Tunnel, error) {
	endpoint, err := resolveEndpoint(ctx, cfg.endpoint)
	if err != nil {
		return nil, err
	}
	tunDev, tnet, err := netstack.CreateNetTUN(cfg.interfaceAddrs(), cfg.dns, cfg.mtu)
	if err != nil {
		return nil, fmt.Errorf("netstack: %w", err)
	}
	wgLog := &device.Logger{
		Verbosef: func(format string, args ...any) { log.Debug("wireguard: " + fmt.Sprintf(format, args...)) },
		Errorf:   func(format string, args ...any) { log.Error("wireguard: " + fmt.Sprintf(format, args...)) },
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), wgLog)
	if err := dev.IpcSet(cfg.uapi(endpoint)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("wireguard config rejected: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("wireguard up: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	t := &Tunnel{
		cfg:       cfg,
		log:       log,
		dev:       dev,
		tnet:      tnet,
		startedAt: time.Now(),
		endpoint:  endpoint,
		cancel:    cancel,
		finished:  make(chan struct{}),
	}
	if err := t.listen(runCtx); err != nil {
		t.Close()
		return nil, err
	}
	go func() {
		defer close(t.finished)
		<-dev.Wait()
		t.setLastError("wireguard device stopped")
	}()
	return t, nil
}

func (t *Tunnel) listen(ctx context.Context) error {
	if !t.cfg.socksDisabled {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(t.cfg.socksPort)))
		if err != nil {
			return fmt.Errorf("socks listen: %w", err)
		}
		t.socks = newSocksServer(ln, t.tnet.DialContext, t.log)
		go t.socks.serve(ctx)
	}
	statusLn, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(t.cfg.statusPort)))
	if err != nil {
		return fmt.Errorf("status listen: %w", err)
	}
	t.status = newStatusServer(statusLn, t)
	go t.status.serve()

	for _, f := range t.cfg.forwards {
		fl, err := newForwardListener(t.tnet, f, t.log)
		if err != nil {
			return err
		}
		t.forwards = append(t.forwards, fl)
		go fl.serve(ctx)
	}
	if len(t.cfg.dnsRecords) > 0 {
		addrs := t.cfg.interfaceAddrs()
		r, err := newDNSResponder(t.tnet, netip.AddrPortFrom(addrs[0], 53), t.cfg.dnsRecords, t.log)
		if err != nil {
			return err
		}
		t.dnsServer = r
		go r.serve(ctx)
	}
	return nil
}

// SocksPort and StatusPort report the bound ports (status may have been 0 = ephemeral).
func (t *Tunnel) SocksPort() int {
	if t.socks == nil {
		return 0
	}
	return t.socks.ln.Addr().(*net.TCPAddr).Port
}

func (t *Tunnel) StatusPort() int { return t.status.ln.Addr().(*net.TCPAddr).Port }

// Close stops everything; safe to call twice.
func (t *Tunnel) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.mu.Unlock()
	t.cancel()
	if t.socks != nil {
		t.socks.close()
	}
	if t.status != nil {
		t.status.close()
	}
	for _, f := range t.forwards {
		f.close()
	}
	if t.dnsServer != nil {
		t.dnsServer.close()
	}
	t.dev.Close()
}

// Done is closed when the WireGuard device stops for any reason.
func (t *Tunnel) Done() <-chan struct{} { return t.finished }

func (t *Tunnel) setLastError(msg string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastErr = msg
}

// peerStats parses the UAPI dump of the single peer.
type peerStats struct {
	endpoint      string
	listenPort    int
	lastHandshake time.Time
	rxBytes       int64
	txBytes       int64
}

func (t *Tunnel) stats() (peerStats, error) {
	dump, err := t.dev.IpcGet()
	if err != nil {
		return peerStats{}, err
	}
	return parseUapiStats(dump), nil
}

func parseUapiStats(dump string) peerStats {
	var s peerStats
	var sec, nsec int64
	sc := bufio.NewScanner(strings.NewReader(dump))
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch key {
		case "endpoint":
			s.endpoint = value
		case "listen_port":
			s.listenPort, _ = strconv.Atoi(value)
		case "last_handshake_time_sec":
			sec, _ = strconv.ParseInt(value, 10, 64)
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(value, 10, 64)
		case "rx_bytes":
			s.rxBytes, _ = strconv.ParseInt(value, 10, 64)
		case "tx_bytes":
			s.txBytes, _ = strconv.ParseInt(value, 10, 64)
		}
	}
	if sec > 0 {
		s.lastHandshake = time.Unix(sec, nsec).UTC()
	}
	return s
}

// resolveEndpoint turns host:port into ip:port with the host resolver (the VPN server's own name is the
// one name that legitimately resolves outside the tunnel). Empty stays empty (server mode).
func resolveEndpoint(ctx context.Context, endpoint string) (string, error) {
	if endpoint == "" {
		return "", nil
	}
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		return "", fieldErr("endpoint", "must be host:port")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return net.JoinHostPort(ip.String(), port), nil
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(lookupCtx, "ip", host)
	if err != nil {
		return "", fmt.Errorf("endpoint %q: %w", host, err)
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("endpoint %q: no addresses", host)
	}
	// Prefer IPv4: most home networks and containers lack IPv6 egress.
	chosen := ips[0]
	for _, ip := range ips {
		if ip.Unmap().Is4() {
			chosen = ip
			break
		}
	}
	return net.JoinHostPort(chosen.Unmap().String(), port), nil
}
