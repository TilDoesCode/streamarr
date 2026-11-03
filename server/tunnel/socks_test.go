package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"syscall"
	"testing"
	"time"
)

type recordedDial struct {
	addrs chan string
	err   error
}

func (d *recordedDial) dial(_ context.Context, _, address string) (net.Conn, error) {
	d.addrs <- address
	if d.err != nil {
		return nil, d.err
	}
	client, server := net.Pipe()
	go func() {
		buf := make([]byte, 64)
		n, _ := server.Read(buf)
		_, _ = server.Write(append([]byte("echo:"), buf[:n]...))
		_ = server.Close()
	}()
	return client, nil
}

func startSocks(t *testing.T, d *recordedDial) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := newSocksServer(ln, d.dial, newLogger(io.Discard, false))
	ctx, cancel := context.WithCancel(context.Background())
	go s.serve(ctx)
	t.Cleanup(func() { cancel(); s.close() })
	return ln.Addr().String()
}

func connectSocks(t *testing.T, addr string, request []byte) (net.Conn, []byte) {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	var method [2]byte
	if _, err := io.ReadFull(c, method[:]); err != nil {
		t.Fatal(err)
	}
	if method != [2]byte{0x05, 0x00} {
		t.Fatalf("method reply %v", method)
	}
	if _, err := c.Write(request); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatal(err)
	}
	return c, reply
}

func TestSocks_ConnectWithDomainName_IsResolvedByTheDialer(t *testing.T) {
	d := &recordedDial{addrs: make(chan string, 1)}
	addr := startSocks(t, d)
	name := "indexer.example.test"
	req := append([]byte{0x05, 0x01, 0x00, 0x03, byte(len(name))}, []byte(name)...)
	req = append(req, 0x01, 0xBB)
	c, reply := connectSocks(t, addr, req)
	defer c.Close()
	if reply[1] != socksRepSuccess {
		t.Fatalf("reply code %d", reply[1])
	}
	if got := <-d.addrs; got != "indexer.example.test:443" {
		t.Fatalf("dialed %q", got)
	}
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, _ := io.ReadAtLeast(c, buf, len("echo:ping"))
	if string(buf[:n]) != "echo:ping" {
		t.Fatalf("relayed %q", buf[:n])
	}
}

func TestSocks_ConnectWithIPv4AndIPv6(t *testing.T) {
	d := &recordedDial{addrs: make(chan string, 2)}
	addr := startSocks(t, d)
	c, reply := connectSocks(t, addr, []byte{0x05, 0x01, 0x00, 0x01, 203, 0, 113, 7, 0x00, 0x50})
	c.Close()
	if reply[1] != socksRepSuccess || <-d.addrs != "203.0.113.7:80" {
		t.Fatalf("ipv4 connect failed: %v", reply)
	}
	v6 := append([]byte{0x05, 0x01, 0x00, 0x04}, net.ParseIP("2001:db8::1").To16()...)
	v6 = append(v6, 0x1F, 0x90)
	c, reply = connectSocks(t, addr, v6)
	c.Close()
	if reply[1] != socksRepSuccess || <-d.addrs != "[2001:db8::1]:8080" {
		t.Fatalf("ipv6 connect failed: %v", reply)
	}
}

func TestSocks_RejectsAuthOnlyClientsAndUnsupportedCommands(t *testing.T) {
	d := &recordedDial{addrs: make(chan string, 1)}
	addr := startSocks(t, d)

	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = c.Write([]byte{0x05, 0x01, 0x02})
	var method [2]byte
	_, _ = io.ReadFull(c, method[:])
	c.Close()
	if method != [2]byte{0x05, socksNoAcceptable} {
		t.Fatalf("username/password-only client got %v", method)
	}

	c, reply := connectSocks(t, addr, []byte{0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50})
	c.Close()
	if reply[1] != socksRepCmdUnsupp {
		t.Fatalf("BIND reply %d", reply[1])
	}
	select {
	case got := <-d.addrs:
		t.Fatalf("unexpected dial %q", got)
	default:
	}
}

func TestSocks_DialFailuresMapToReplyCodes(t *testing.T) {
	d := &recordedDial{addrs: make(chan string, 1), err: &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}}
	addr := startSocks(t, d)
	c, reply := connectSocks(t, addr, []byte{0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x50})
	c.Close()
	<-d.addrs
	if reply[1] != socksRepRefused {
		t.Fatalf("refused mapped to %d", reply[1])
	}

	d.err = &net.DNSError{Err: "no such host", Name: "x.test", IsNotFound: true}
	c, reply = connectSocks(t, addr, []byte{0x05, 0x01, 0x00, 0x01, 10, 0, 0, 2, 0x00, 0x50})
	c.Close()
	<-d.addrs
	if reply[1] != socksRepHostUnr {
		t.Fatalf("dns failure mapped to %d", reply[1])
	}
	if socksReplyFor(errors.New("boom")) != socksRepFailure {
		t.Fatal("unknown errors must be a general failure")
	}
}

func TestSocksHandshake_RejectsOtherVersions(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	go func() { _, _ = client.Write([]byte{0x04, 0x01}); _, _ = io.Copy(io.Discard, client) }()
	_ = server.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := socksHandshake(server); err == nil || !bytes.Contains([]byte(err.Error()), []byte("version")) {
		t.Fatalf("expected a version error, got %v", err)
	}
}
