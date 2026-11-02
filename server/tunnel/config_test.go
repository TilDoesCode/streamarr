package main

import (
	"strings"
	"testing"
)

const (
	testPrivateKey = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo="
	testPeerKey    = "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08="
	testPsk        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="
)

func validConfig() *Config {
	return &Config{
		PrivateKey:    testPrivateKey,
		PeerPublicKey: testPeerKey,
		PresharedKey:  testPsk,
		Endpoint:      "vpn.example.test:51820",
		Addresses:     []string{"10.64.12.3/32", "fc00:bbbb::1"},
		DNS:           []string{"10.64.0.1"},
		Keepalive:     25,
		AllowedIPs:    []string{"0.0.0.0/0", "::/0"},
		SocksPort:     41800,
		StatusPort:    41900,
		DNSRecords:    map[string]string{"Web.Test": "10.200.0.1"},
	}
}

func TestReadConfig_ParsesJSON(t *testing.T) {
	cfg, err := ReadConfig(strings.NewReader(`{"privateKey":"a","addresses":["10.0.0.2/32"],"allowedIps":["0.0.0.0/0"],"socksPort":1,"statusPort":2,"unknownField":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PrivateKey != "a" || cfg.SocksPort != 1 || len(cfg.Addresses) != 1 {
		t.Fatalf("unexpected config %+v", cfg)
	}
	if _, err := ReadConfig(strings.NewReader(`not json`)); err == nil {
		t.Fatal("expected a JSON error")
	}
}

func TestResolve_ValidConfig(t *testing.T) {
	r, err := validConfig().Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if r.mtu != defaultMTU {
		t.Fatalf("mtu default = %d", r.mtu)
	}
	if len(r.addresses) != 2 || r.addresses[1].Bits() != 128 {
		t.Fatalf("addresses = %v", r.addresses)
	}
	if r.exitCheckURL != DefaultExitCheckURL {
		t.Fatalf("exit url = %q", r.exitCheckURL)
	}
	if _, ok := r.dnsRecords["web.test."]; !ok {
		t.Fatalf("dns records not normalized: %v", r.dnsRecords)
	}
	uapi := r.uapi("203.0.113.5:51820")
	for _, want := range []string{
		"private_key=77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a\n",
		"public_key=de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f\n",
		"preshared_key=0000000000000000000000000000000000000000000000000000000000000001\n",
		"endpoint=203.0.113.5:51820\n",
		"persistent_keepalive_interval=25\n",
		"allowed_ip=0.0.0.0/0\n",
		"allowed_ip=::/0\n",
	} {
		if !strings.Contains(uapi, want) {
			t.Errorf("uapi missing %q:\n%s", want, uapi)
		}
	}
}

func TestResolve_FieldErrors(t *testing.T) {
	cases := map[string]func(c *Config){
		"privateKey":    func(c *Config) { c.PrivateKey = "short" },
		"peerPublicKey": func(c *Config) { c.PeerPublicKey = "!!!" },
		"presharedKey":  func(c *Config) { c.PresharedKey = "AAAA" },
		"endpoint":      func(c *Config) { c.Endpoint = ""; c.ListenPort = 0 },
		"addresses":     func(c *Config) { c.Addresses = []string{"10.0.0.300/32"} },
		"dns":           func(c *Config) { c.DNS = []string{"dns.example"} },
		"mtu":           func(c *Config) { c.MTU = 1000 },
		"keepalive":     func(c *Config) { c.Keepalive = -1 },
		"allowedIps":    func(c *Config) { c.AllowedIPs = []string{"10.0.0.1"} },
		"socksPort":     func(c *Config) { c.SocksPort = 70000 },
		"exitCheckUrl":  func(c *Config) { c.ExitCheckURL = "ftp://x" },
		"forwards":      func(c *Config) { c.Forwards = []Forward{{Listen: "nope", Target: "127.0.0.1:1"}} },
		"dnsRecords":    func(c *Config) { c.DNSRecords = map[string]string{"a.test": "not-an-ip"} },
	}
	for field, mutate := range cases {
		cfg := validConfig()
		mutate(cfg)
		_, err := cfg.Resolve()
		fe, ok := err.(*FieldError)
		if !ok {
			t.Errorf("%s: expected a FieldError, got %v", field, err)
			continue
		}
		if fe.Field != field {
			t.Errorf("expected field %q, got %q (%s)", field, fe.Field, fe.Msg)
		}
	}
}

func TestResolve_ServerModeNeedsNoEndpoint(t *testing.T) {
	cfg := validConfig()
	cfg.Endpoint = ""
	cfg.ListenPort = 51820
	cfg.SocksDisabled = true
	r, err := cfg.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.uapi(""), "listen_port=51820\n") || strings.Contains(r.uapi(""), "endpoint=") {
		t.Fatalf("server uapi wrong:\n%s", r.uapi(""))
	}
}

func TestParseUapiStats(t *testing.T) {
	s := parseUapiStats("private_key=x\nlisten_port=0\npublic_key=y\nendpoint=203.0.113.5:51820\nlast_handshake_time_sec=1700000000\nlast_handshake_time_nsec=5\ntx_bytes=1234\nrx_bytes=99\nallowed_ip=0.0.0.0/0\n")
	if s.endpoint != "203.0.113.5:51820" || s.txBytes != 1234 || s.rxBytes != 99 || s.lastHandshake.Unix() != 1700000000 {
		t.Fatalf("unexpected stats %+v", s)
	}
	if !parseUapiStats("last_handshake_time_sec=0\n").lastHandshake.IsZero() {
		t.Fatal("zero handshake must stay zero")
	}
}

func TestParseExitIP(t *testing.T) {
	for body, want := range map[string]string{
		`{"ip":"203.0.113.9"}`:                        "203.0.113.9",
		`{"ip":"2001:db8::1","country":"SE"}`:         "2001:db8::1",
		"198.51.100.4\n":                              "198.51.100.4",
		`{"query":"198.51.100.5","status":"success"}`: "198.51.100.5",
	} {
		got, err := parseExitIP([]byte(body))
		if err != nil || got != want {
			t.Errorf("%s: got %q, %v", body, got, err)
		}
	}
	for _, body := range []string{`{"country":"SE"}`, "<html>", ""} {
		if _, err := parseExitIP([]byte(body)); err == nil {
			t.Errorf("%q: expected an error", body)
		}
	}
}
