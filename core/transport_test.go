package core

import (
	"testing"
	"time"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/event"
	"github.com/geekgonecrazy/cairn/relay"
	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// fakeTransport captures broadcasts and lets a test inject inbound events.
type fakeTransport struct {
	got     chan *cairnv1.Event
	inbound chan *cairnv1.Event
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{
		got:     make(chan *cairnv1.Event, 16),
		inbound: make(chan *cairnv1.Event, 16),
	}
}

func (*fakeTransport) Name() string                     { return "fake" }
func (*fakeTransport) Available() bool                  { return true }
func (f *fakeTransport) Broadcast(ev *cairnv1.Event)    { f.got <- ev }
func (f *fakeTransport) Inbound() <-chan *cairnv1.Event { return f.inbound }

// The transport seam: a locally-submitted event fans out over every transport,
// and an event arriving from a transport's peers flows through the same
// verify→store→fold path via the consume loop.
func TestTransportSeam(t *testing.T) {
	setTestStore(t)
	config.Config.RequireInvite = false
	t.Cleanup(func() { config.Config.RequireInvite = false })

	pub, priv, err := relay.LoadOrCreateKey(st)
	if err != nil {
		t.Fatal(err)
	}
	relayPub, relayPriv = pub, priv

	prev := transports
	resetTransports()
	t.Cleanup(func() { transports = prev })

	ft := newFakeTransport()
	RegisterTransport(ft)

	m := newHousehold(t).member(t, "A")
	m.install(t)

	// Outbound: a locally-submitted event fans out over the transport.
	ev, err := event.Build(m.device.Pub, m.device.Priv, []byte("room"), 1, nil, cairnv1.EventType_CHAT, []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	if err := SubmitEvent(ev); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case <-ft.got:
	case <-time.After(2 * time.Second):
		t.Fatal("locally-submitted event did not fan out over the transport")
	}

	// Inbound: an event arriving from the transport's peers is stored via the
	// consume loop, and tagged with the transport it arrived on.
	ev2, err := event.Build(m.device.Pub, m.device.Priv, []byte("room"), 2, nil, cairnv1.EventType_CHAT, []byte("yo"))
	if err != nil {
		t.Fatal(err)
	}
	ft.inbound <- ev2

	deadline := time.Now().Add(2 * time.Second)
	for {
		if has, _ := st.HasEvent(ev2.EventId); has {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("inbound event from the transport was not stored")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// (arrived_via is a receiver-local annotation and is deliberately NOT
	// persisted — see event.go — so we don't assert it survives storage.)
}
