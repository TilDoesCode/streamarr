package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/net/proxy"
)

func genKeyPair(t *testing.T) (priv, pub string) {
	t.Helper()
	var sk [32]byte
	if _, err := rand.Read(sk[:]); err != nil {
		t.Fatal(err)
	}
	sk[0] &= 248
	sk[31] &= 127
	sk[31] |= 64
	pk, err := curve25519.X25519(sk[:], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sk[:]), base64.StdEncoding.EncodeToString(pk)
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	l, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.LocalAddr().(*net.UDPAddr).Port
}

func startTunnel(t *testing.T, cfg *Config) *Tunnel {
	t.Helper()
	res, err := cfg.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	tun, err := Start(context.Background(), res, newLogger(io.Discard, false))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tun.Close)
	return tun
}

// pair is a "VPN server" tunnel exposing backend at web.test:8080 inside the WireGuard network and a
// client tunnel peered with it over loopback UDP.
type pair struct {
	server, client *Tunnel
	clientCfg      *Config
	backend        *httptest.Server
}

func startPair(t *testing.T, clientDNS []string) *pair {
	t.Helper()
	serverPriv, serverPub := genKeyPair(t)
	clientPriv, clientPub := genKeyPair(t)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/hello":
			_, _ = fmt.Fprint(w, "hello through the tunnel")
		case "/ip":
			_, _ = fmt.Fprint(w, `{"ip":"10.200.0.2"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(backend.Close)
	udpPort := freeUDPPort(t)
	server := startTunnel(t, &Config{
		PrivateKey:    serverPriv,
		PeerPublicKey: clientPub,
		ListenPort:    udpPort,
		Addresses:     []string{"10.200.0.1/24"},
		AllowedIPs:    []string{"10.200.0.2/32"},
		SocksDisabled: true,
		Forwards:      []Forward{{Listen: "10.200.0.1:8080", Target: backend.Listener.Addr().String()}},
		DNSRecords:    map[string]string{"web.test": "10.200.0.1"},
	})
	clientCfg := &Config{
		PrivateKey:    clientPriv,
		PeerPublicKey: serverPub,
		Endpoint:      "127.0.0.1:" + strconv.Itoa(udpPort),
		Addresses:     []string{"10.200.0.2/32"},
		DNS:           clientDNS,
		AllowedIPs:    []string{"10.200.0.0/24"},
		Keepalive:     5,
		ExitCheckURL:  "http://web.test:8080/ip",
	}
	client := startTunnel(t, clientCfg)
	return &pair{server: server, client: client, clientCfg: clientCfg, backend: backend}
}

func socksHTTPClient(t *testing.T, socksPort int) *http.Client {
	t.Helper()
	dialer, err := proxy.SOCKS5("tcp", "127.0.0.1:"+strconv.Itoa(socksPort), nil, proxy.Direct)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext:       dialer.(proxy.ContextDialer).DialContext,
			DisableKeepAlives: true,
		},
	}
}

func getBody(t *testing.T, c *http.Client, url string) string {
	t.Helper()
	res, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: HTTP %d %s", url, res.StatusCode, body)
	}
	return string(body)
}

func TestTunnelPair_SocksConnectByNameThroughRealWireGuard(t *testing.T) {
	p := startPair(t, []string{"10.200.0.1"})
	hc := socksHTTPClient(t, p.client.SocksPort())

	if body := getBody(t, hc, "http://web.test:8080/hello"); body != "hello through the tunnel" {
		t.Fatalf("body %q", body)
	}

	var status StatusResponse
	getJSON(t, "http://127.0.0.1:"+strconv.Itoa(p.client.StatusPort())+"/status", &status)
	if status.LastHandshakeUtc == nil || status.RxBytes == 0 || status.TxBytes == 0 {
		t.Fatalf("status after traffic: %+v", status)
	}
	if status.SocksPort != p.client.SocksPort() || status.Endpoint != p.clientCfg.Endpoint {
		t.Fatalf("status ports/endpoint: %+v", status)
	}
	if status.LastError != nil {
		t.Fatalf("unexpected lastError %q", *status.LastError)
	}

	var exit ExitResponse
	getJSON(t, "http://127.0.0.1:"+strconv.Itoa(p.client.StatusPort())+"/exit", &exit)
	if !exit.Ok || exit.IP != "10.200.0.2" || exit.LatencyMs <= 0 {
		t.Fatalf("exit check: %+v", exit)
	}

	var serverStatus StatusResponse
	getJSON(t, "http://127.0.0.1:"+strconv.Itoa(p.server.StatusPort())+"/status", &serverStatus)
	if serverStatus.LastHandshakeUtc == nil || serverStatus.SocksPort != 0 {
		t.Fatalf("server status: %+v", serverStatus)
	}

	if _, err := hc.Get("http://nowhere.test:8080/"); err == nil {
		t.Fatal("an unknown name must fail")
	}
	if _, err := hc.Get("http://10.200.0.1:9/"); err == nil {
		t.Fatal("a closed port behind the server must fail")
	}
}

func TestTunnelPair_WithoutTunnelDNS_NamesFailClosedButAddressesWork(t *testing.T) {
	p := startPair(t, nil)
	hc := socksHTTPClient(t, p.client.SocksPort())

	// localhost resolves on every host resolver; inside the tunnel there is no resolver at all.
	_, err := hc.Get("http://localhost:8080/hello")
	if err == nil || !strings.Contains(err.Error(), "socks") {
		t.Fatalf("expected a SOCKS failure for a name without tunnel DNS, got %v", err)
	}
	if body := getBody(t, hc, "http://10.200.0.1:8080/hello"); body != "hello through the tunnel" {
		t.Fatalf("body %q", body)
	}
}

func TestStatus_ReportsHandshakeTimeoutAgainstUnreachableEndpoint(t *testing.T) {
	priv, _ := genKeyPair(t)
	_, peer := genKeyPair(t)
	tun := startTunnel(t, &Config{
		PrivateKey:    priv,
		PeerPublicKey: peer,
		Endpoint:      "192.0.2.1:51820",
		Addresses:     []string{"10.0.0.2/32"},
		DNS:           []string{"10.0.0.1"},
		AllowedIPs:    []string{"0.0.0.0/0"},
	})
	tun.startedAt = time.Now().Add(-handshakeTimeout - time.Second)
	status := tun.Status()
	if status.LastError == nil || !strings.HasPrefix(*status.LastError, "handshake timeout: no handshake with 192.0.2.1:51820") {
		t.Fatalf("status: %+v", status)
	}
	if status.LastHandshakeUtc != nil {
		t.Fatal("no handshake can have happened")
	}
}

func TestRun_ValidateAndVersion(t *testing.T) {
	var out, errOut strings.Builder
	if code := run([]string{"-version"}, strings.NewReader(""), &out, &errOut); code != exitOK || !strings.Contains(out.String(), "streamarr-tunnel") {
		t.Fatalf("version: code %d out %q", code, out.String())
	}
	cfg, _ := json.Marshal(validConfig())
	if code := run([]string{"-validate"}, strings.NewReader(string(cfg)), &out, &errOut); code != exitOK {
		t.Fatalf("validate: code %d stderr %s", code, errOut.String())
	}
	errOut.Reset()
	if code := run([]string{"-validate"}, strings.NewReader(`{"privateKey":"x"}`), &out, &errOut); code != exitConfig || !strings.Contains(errOut.String(), `"field":"privateKey"`) {
		t.Fatalf("invalid: code %d stderr %s", code, errOut.String())
	}
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}
