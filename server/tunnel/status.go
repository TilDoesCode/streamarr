package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// StatusResponse is GET /status.
type StatusResponse struct {
	SocksPort           int      `json:"socksPort"`
	StatusPort          int      `json:"statusPort"`
	Endpoint            string   `json:"endpoint"`
	ListenPort          int      `json:"listenPort"`
	StartedAtUtc        string   `json:"startedAtUtc"`
	UptimeSeconds       float64  `json:"uptimeSeconds"`
	LastHandshakeUtc    *string  `json:"lastHandshakeUtc"`
	HandshakeAgeSeconds *float64 `json:"handshakeAgeSeconds"`
	RxBytes             int64    `json:"rxBytes"`
	TxBytes             int64    `json:"txBytes"`
	LastError           *string  `json:"lastError"`
}

// ExitResponse is GET /exit: the exit-IP check performed through the tunnel.
type ExitResponse struct {
	Ok        bool    `json:"ok"`
	IP        string  `json:"ip,omitempty"`
	LatencyMs float64 `json:"latencyMs"`
	URL       string  `json:"url"`
	Error     string  `json:"error,omitempty"`
}

const (
	exitCheckTimeout = 20 * time.Second
	// handshakeTimeout: no handshake since start → lastError names the endpoint; handshakeStale: last one too old.
	handshakeTimeout = 30 * time.Second
	handshakeStale   = 3 * time.Minute
)

type statusServer struct {
	ln  net.Listener
	srv *http.Server
	t   *Tunnel
}

func newStatusServer(ln net.Listener, t *Tunnel) *statusServer {
	s := &statusServer{ln: ln, t: t}
	mux := http.NewServeMux()
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/exit", s.handleExit)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	return s
}

func (s *statusServer) serve() {
	if err := s.srv.Serve(s.ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		s.t.log.Error("status server stopped", "error", err.Error())
	}
}

func (s *statusServer) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.srv.Shutdown(ctx)
}

func (s *statusServer) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.t.Status())
}

// Status is the current snapshot (also used by the ready line and tests).
func (t *Tunnel) Status() StatusResponse {
	now := time.Now()
	resp := StatusResponse{
		SocksPort:     t.SocksPort(),
		StatusPort:    t.StatusPort(),
		Endpoint:      t.endpoint,
		StartedAtUtc:  t.startedAt.UTC().Format(time.RFC3339),
		UptimeSeconds: now.Sub(t.startedAt).Seconds(),
	}
	var handshakeErr string
	if st, err := t.stats(); err == nil {
		if st.endpoint != "" {
			resp.Endpoint = st.endpoint
		}
		resp.ListenPort = st.listenPort
		resp.RxBytes = st.rxBytes
		resp.TxBytes = st.txBytes
		if !st.lastHandshake.IsZero() {
			hs := st.lastHandshake.Format(time.RFC3339)
			age := now.Sub(st.lastHandshake).Seconds()
			resp.LastHandshakeUtc = &hs
			resp.HandshakeAgeSeconds = &age
			if age > handshakeStale.Seconds() {
				handshakeErr = fmt.Sprintf("handshake stale: last handshake with %s %.0fs ago", resp.Endpoint, age)
			}
		} else if resp.UptimeSeconds > handshakeTimeout.Seconds() && t.endpoint != "" {
			handshakeErr = fmt.Sprintf("handshake timeout: no handshake with %s after %.0fs", resp.Endpoint, resp.UptimeSeconds)
		}
	} else {
		t.setLastError("status: " + err.Error())
	}
	t.mu.Lock()
	lastErr := t.lastErr
	t.mu.Unlock()
	if handshakeErr != "" {
		resp.LastError = &handshakeErr
	} else if lastErr != "" {
		resp.LastError = &lastErr
	}
	return resp
}

func (s *statusServer) handleExit(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), exitCheckTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, s.t.ExitCheck(ctx))
}

// ExitCheck fetches the exit-IP URL through the tunnel and reports the address plus round-trip latency.
func (t *Tunnel) ExitCheck(ctx context.Context) ExitResponse {
	resp := ExitResponse{URL: t.cfg.exitCheckURL}
	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           t.tnet.DialContext,
			Proxy:                 nil,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
			DisableKeepAlives:     true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") },
	}
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.cfg.exitCheckURL, nil)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	req.Header.Set("User-Agent", "streamarr-tunnel")
	req.Header.Set("Accept", "application/json, text/plain")
	res, err := client.Do(req)
	resp.LatencyMs = float64(time.Since(started).Microseconds()) / 1000
	if err != nil {
		resp.Error = "exit check failed: " + err.Error()
		return resp
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if err != nil {
		resp.Error = "exit check failed: " + err.Error()
		return resp
	}
	if res.StatusCode/100 != 2 {
		resp.Error = "exit check returned HTTP " + res.Status
		return resp
	}
	ip, err := parseExitIP(body)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	resp.Ok = true
	resp.IP = ip
	return resp
}

// parseExitIP accepts {"ip":"…"} (ipify, Mullvad, ifconfig.co) or a bare address body.
func parseExitIP(body []byte) (string, error) {
	text := strings.TrimSpace(string(body))
	if strings.HasPrefix(text, "{") {
		var doc map[string]any
		if err := json.Unmarshal(body, &doc); err == nil {
			for _, key := range []string{"ip", "query", "ip_addr", "IP"} {
				if v, ok := doc[key].(string); ok {
					if a, err := netip.ParseAddr(strings.TrimSpace(v)); err == nil {
						return a.String(), nil
					}
				}
			}
		}
		return "", errors.New("exit check response has no ip field")
	}
	if a, err := netip.ParseAddr(text); err == nil {
		return a.String(), nil
	}
	return "", errors.New("exit check response is not an IP address")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
