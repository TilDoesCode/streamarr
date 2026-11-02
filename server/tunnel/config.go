// streamarr-tunnel: userspace WireGuard tunnel exposed as a loopback SOCKS5 proxy (docs/vpn.md).
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
)

// Forward exposes a host service inside the tunnel (test and "VPN server" mode): the helper listens on
// Listen inside the WireGuard network and pipes every connection to Target on the host.
type Forward struct {
	Listen string `json:"listen"`
	Target string `json:"target"`
}

// Config is the JSON document the server writes to the helper's stdin. Secrets never appear on argv.
type Config struct {
	PrivateKey    string            `json:"privateKey"`
	PeerPublicKey string            `json:"peerPublicKey"`
	PresharedKey  string            `json:"presharedKey,omitempty"`
	Endpoint      string            `json:"endpoint,omitempty"`
	ListenPort    int               `json:"listenPort,omitempty"`
	Addresses     []string          `json:"addresses"`
	DNS           []string          `json:"dns,omitempty"`
	MTU           int               `json:"mtu,omitempty"`
	Keepalive     int               `json:"keepalive,omitempty"`
	AllowedIPs    []string          `json:"allowedIps"`
	SocksPort     int               `json:"socksPort"`
	SocksDisabled bool              `json:"socksDisabled,omitempty"`
	StatusPort    int               `json:"statusPort"`
	ExitCheckURL  string            `json:"exitCheckUrl,omitempty"`
	Forwards      []Forward         `json:"forwards,omitempty"`
	DNSRecords    map[string]string `json:"dnsRecords,omitempty"`
	LogLevel      string            `json:"logLevel,omitempty"`
}

// DefaultExitCheckURL answers {"ip":"…"} for the address the request left from.
const DefaultExitCheckURL = "https://api.ipify.org?format=json"

const (
	minMTU     = 1280
	maxMTU     = 65535
	defaultMTU = 1420
)

// resolved is a validated Config with keys as UAPI hex strings and addresses parsed.
type resolved struct {
	privateKeyHex    string
	peerPublicKeyHex string
	presharedKeyHex  string
	endpoint         string
	listenPort       int
	addresses        []netip.Prefix
	dns              []netip.Addr
	mtu              int
	keepalive        int
	allowedIPs       []netip.Prefix
	socksPort        int
	socksDisabled    bool
	statusPort       int
	exitCheckURL     string
	forwards         []forward
	dnsRecords       map[string]netip.Addr
	verbose          bool
}

type forward struct {
	listen netip.AddrPort
	target string
}

// FieldError names the offending config field so the server can show it.
type FieldError struct {
	Field string
	Msg   string
}

func (e *FieldError) Error() string { return e.Field + ": " + e.Msg }

func fieldErr(field, format string, args ...any) error {
	return &FieldError{Field: field, Msg: fmt.Sprintf(format, args...)}
}

// ReadConfig decodes the first JSON document on r.
func ReadConfig(r io.Reader) (*Config, error) {
	var cfg Config
	dec := json.NewDecoder(io.LimitReader(r, 1<<20))
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	return &cfg, nil
}

// Resolve validates cfg and converts it into the form the device needs. The endpoint hostname is not
// resolved here; see resolveEndpoint.
func (c *Config) Resolve() (*resolved, error) {
	r := &resolved{
		listenPort:    c.ListenPort,
		mtu:           c.MTU,
		keepalive:     c.Keepalive,
		socksPort:     c.SocksPort,
		socksDisabled: c.SocksDisabled,
		statusPort:    c.StatusPort,
		exitCheckURL:  strings.TrimSpace(c.ExitCheckURL),
		verbose:       strings.EqualFold(c.LogLevel, "verbose"),
	}
	var err error
	if r.privateKeyHex, err = keyHex(c.PrivateKey); err != nil {
		return nil, fieldErr("privateKey", "%v", err)
	}
	if r.peerPublicKeyHex, err = keyHex(c.PeerPublicKey); err != nil {
		return nil, fieldErr("peerPublicKey", "%v", err)
	}
	if c.PresharedKey != "" {
		if r.presharedKeyHex, err = keyHex(c.PresharedKey); err != nil {
			return nil, fieldErr("presharedKey", "%v", err)
		}
	}
	if c.ListenPort < 0 || c.ListenPort > 65535 {
		return nil, fieldErr("listenPort", "must be between 0 and 65535")
	}
	if ep := strings.TrimSpace(c.Endpoint); ep != "" {
		host, port, err := net.SplitHostPort(ep)
		if err != nil || host == "" || port == "" {
			return nil, fieldErr("endpoint", "must be host:port")
		}
		r.endpoint = ep
	} else if c.ListenPort == 0 {
		return nil, fieldErr("endpoint", "required unless listenPort is set")
	}
	if len(c.Addresses) == 0 {
		return nil, fieldErr("addresses", "at least one interface address is required")
	}
	for _, a := range c.Addresses {
		p, err := parsePrefixOrAddr(a)
		if err != nil {
			return nil, fieldErr("addresses", "%q: %v", a, err)
		}
		r.addresses = append(r.addresses, p)
	}
	for _, d := range c.DNS {
		ip, err := netip.ParseAddr(strings.TrimSpace(d))
		if err != nil {
			return nil, fieldErr("dns", "%q is not an IP address", d)
		}
		r.dns = append(r.dns, ip)
	}
	if r.mtu == 0 {
		r.mtu = defaultMTU
	}
	if r.mtu < minMTU || r.mtu > maxMTU {
		return nil, fieldErr("mtu", "must be between %d and %d", minMTU, maxMTU)
	}
	if r.keepalive < 0 || r.keepalive > 65535 {
		return nil, fieldErr("keepalive", "must be between 0 and 65535")
	}
	if len(c.AllowedIPs) == 0 {
		return nil, fieldErr("allowedIps", "at least one CIDR is required")
	}
	for _, a := range c.AllowedIPs {
		p, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err != nil {
			return nil, fieldErr("allowedIps", "%q is not a CIDR", a)
		}
		r.allowedIPs = append(r.allowedIPs, p.Masked())
	}
	if c.SocksPort < 0 || c.SocksPort > 65535 {
		return nil, fieldErr("socksPort", "must be between 0 and 65535")
	}
	if c.StatusPort < 0 || c.StatusPort > 65535 {
		return nil, fieldErr("statusPort", "must be between 0 and 65535")
	}
	if r.exitCheckURL == "" {
		r.exitCheckURL = DefaultExitCheckURL
	}
	if !strings.HasPrefix(r.exitCheckURL, "http://") && !strings.HasPrefix(r.exitCheckURL, "https://") {
		return nil, fieldErr("exitCheckUrl", "must be an http(s) URL")
	}
	for i, f := range c.Forwards {
		ap, err := netip.ParseAddrPort(strings.TrimSpace(f.Listen))
		if err != nil {
			return nil, fieldErr("forwards", "[%d].listen must be ip:port", i)
		}
		if _, _, err := net.SplitHostPort(f.Target); err != nil {
			return nil, fieldErr("forwards", "[%d].target must be host:port", i)
		}
		r.forwards = append(r.forwards, forward{listen: ap, target: f.Target})
	}
	if len(c.DNSRecords) > 0 {
		r.dnsRecords = make(map[string]netip.Addr, len(c.DNSRecords))
		for name, value := range c.DNSRecords {
			ip, err := netip.ParseAddr(value)
			if err != nil {
				return nil, fieldErr("dnsRecords", "%q: %q is not an IP address", name, value)
			}
			r.dnsRecords[strings.ToLower(strings.TrimSuffix(name, "."))+"."] = ip
		}
	}
	return r, nil
}

// uapi renders the WireGuard UAPI configuration (device.IpcSet) with the resolved endpoint.
func (r *resolved) uapi(endpoint string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", r.privateKeyHex)
	fmt.Fprintf(&b, "listen_port=%d\n", r.listenPort)
	b.WriteString("replace_peers=true\n")
	fmt.Fprintf(&b, "public_key=%s\n", r.peerPublicKeyHex)
	if r.presharedKeyHex != "" {
		fmt.Fprintf(&b, "preshared_key=%s\n", r.presharedKeyHex)
	}
	if endpoint != "" {
		fmt.Fprintf(&b, "endpoint=%s\n", endpoint)
	}
	if r.keepalive > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", r.keepalive)
	}
	for _, p := range r.allowedIPs {
		fmt.Fprintf(&b, "allowed_ip=%s\n", p)
	}
	return b.String()
}

func (r *resolved) interfaceAddrs() []netip.Addr {
	out := make([]netip.Addr, 0, len(r.addresses))
	for _, p := range r.addresses {
		out = append(out, p.Addr())
	}
	return out
}

func keyHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return "", errors.New("not valid base64")
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("must decode to 32 bytes, got %d", len(raw))
	}
	return hex.EncodeToString(raw), nil
}

func parsePrefixOrAddr(s string) (netip.Prefix, error) {
	s = strings.TrimSpace(s)
	if p, err := netip.ParsePrefix(s); err == nil {
		return p, nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, errors.New("not an IP address or CIDR")
	}
	return netip.PrefixFrom(a, a.BitLen()), nil
}
