package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"

	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// dnsResponder answers A/AAAA queries inside the tunnel from a static table ("VPN server" test mode).
type dnsResponder struct {
	conn    net.PacketConn
	records map[string]netip.Addr
	log     *logger
}

func newDNSResponder(tnet *netstack.Net, listen netip.AddrPort, records map[string]netip.Addr, log *logger) (*dnsResponder, error) {
	conn, err := tnet.ListenUDPAddrPort(listen)
	if err != nil {
		return nil, fieldErr("dnsRecords", "listen %s: %v", listen, err)
	}
	return &dnsResponder{conn: conn, records: records, log: log}, nil
}

func (r *dnsResponder) serve(ctx context.Context) {
	buf := make([]byte, 1500)
	for {
		n, from, err := r.conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if reply := r.answer(buf[:n]); reply != nil {
			_, _ = r.conn.WriteTo(reply, from)
		}
	}
}

func (r *dnsResponder) close() { _ = r.conn.Close() }

func (r *dnsResponder) answer(query []byte) []byte {
	var p dnsmessage.Parser
	hdr, err := p.Start(query)
	if err != nil {
		return nil
	}
	q, err := p.Question()
	if err != nil {
		return nil
	}
	resp := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: hdr.ID, Response: true, Authoritative: true, RCode: dnsmessage.RCodeSuccess},
		Questions: []dnsmessage.Question{q},
	}
	ip, ok := r.records[strings.ToLower(q.Name.String())]
	switch {
	case !ok:
		resp.Header.RCode = dnsmessage.RCodeNameError
	case q.Type == dnsmessage.TypeA && ip.Is4():
		resp.Answers = []dnsmessage.Resource{{
			Header: dnsmessage.ResourceHeader{Name: q.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AResource{A: ip.As4()},
		}}
	case q.Type == dnsmessage.TypeAAAA && ip.Is6():
		resp.Answers = []dnsmessage.Resource{{
			Header: dnsmessage.ResourceHeader{Name: q.Name, Type: dnsmessage.TypeAAAA, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AAAAResource{AAAA: ip.As16()},
		}}
	}
	out, err := resp.Pack()
	if err != nil {
		return nil
	}
	return out
}
