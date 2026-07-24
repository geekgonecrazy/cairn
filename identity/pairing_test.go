package identity

import (
	"strings"
	"testing"
)

func TestPairingRequestRoundTrip(t *testing.T) {
	dev, _ := GenerateKey()
	req := mustPairing(t, dev.Pub, "Sam's iPhone")

	got, err := ParsePairingRequest(req.Encode())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !got.DevicePub.Equal(dev.Pub) {
		t.Fatal("device pubkey did not survive the QR round trip")
	}
	if got.Label != "Sam's iPhone" {
		t.Fatalf("label = %q", got.Label)
	}
}

func TestPairingRequestEmptyLabel(t *testing.T) {
	dev, _ := GenerateKey()
	req := mustPairing(t, dev.Pub, "")
	got, err := ParsePairingRequest(req.Encode())
	if err != nil {
		t.Fatalf("parse with empty label: %v", err)
	}
	if got.Label != "" {
		t.Fatalf("label = %q, want empty", got.Label)
	}
}

func TestParsePairingRequestRejects(t *testing.T) {
	dev, _ := GenerateKey()
	valid := mustPairing(t, dev.Pub, "x").Encode()

	cases := map[string]string{
		"empty":         "",
		"other qr":      "https://example.com",
		"no version":    "cairn:pair:",
		"bad version":   "cairn:pair:99:AAAA:x",
		"bad base64":    "cairn:pair:1:!!!!:x",
		"short key":     "cairn:pair:1:AAAA:x",
		"truncated":     valid[:len(valid)-40],
		"missing parts": "cairn:pair:1",
	}
	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParsePairingRequest(s); err == nil {
				t.Fatalf("ParsePairingRequest(%q) = nil error, want rejection", s)
			}
		})
	}
}

func TestPairingLabelCannotBreakEncoding(t *testing.T) {
	dev, _ := GenerateKey()
	// A label containing the delimiter would let a scanned code forge fields.
	if _, err := NewPairingRequest(dev.Pub, "evil:cairn:pair:1"); err == nil {
		t.Fatal("label containing ':' was accepted")
	}
	if _, err := NewPairingRequest(dev.Pub, "line\nbreak"); err == nil {
		t.Fatal("label containing a newline was accepted")
	}
}

func TestFingerprintIsStableAndDistinct(t *testing.T) {
	a, _ := GenerateKey()
	b, _ := GenerateKey()

	fa := Fingerprint(a.Pub)
	if fa != Fingerprint(a.Pub) {
		t.Fatal("fingerprint is not stable")
	}
	if fa == Fingerprint(b.Pub) {
		t.Fatal("distinct keys share a fingerprint")
	}
	if n := len(strings.Split(fa, "-")); n != 4 {
		t.Fatalf("fingerprint has %d groups, want 4: %q", n, fa)
	}
}

func TestApprovePairingRejectsBadExpiry(t *testing.T) {
	dev, _ := GenerateKey()
	member, _ := GenerateKey()
	req := mustPairing(t, dev.Pub, "x")

	if _, err := ApprovePairing(req, member.Pub, member.Priv, testNow, testNow-1); err == nil {
		t.Fatal("expires_at before issued_at was accepted")
	}
	if _, err := ApprovePairing(nil, member.Pub, member.Priv, testNow, 0); err == nil {
		t.Fatal("nil request was accepted")
	}
}

func TestExpiredDelegationIsRejected(t *testing.T) {
	member, _ := GenerateKey()
	dev, _ := GenerateKey()

	att, _ := NewSelfAttestation(member, KindHuman, "Sam", nil, testNow)
	dd, _ := ApprovePairing(
		mustPairing(t, dev.Pub, "temp"), member.Pub, member.Priv, testNow, testNow+1000)

	log := NewDeviceLog()
	_ = log.AddAttestation(att)
	_ = log.AddDelegation(dd)

	if _, err := VerifySender(dev.Pub, log, testNow+5000); err == nil {
		t.Fatal("expired delegation verified")
	}
	if _, err := VerifySender(dev.Pub, log, testNow+500); err != nil {
		t.Fatalf("delegation rejected before expiry: %v", err)
	}
}
