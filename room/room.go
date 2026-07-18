// Package room implements per-room end-to-end encryption: the symmetric room
// key (per epoch), the AES-256-GCM payload framing, and the payload CBOR
// schemas. The server never sees a room key — it stores and routes ciphertext.
//
// Payload framing (PROTOCOL.md §2.2):
//
//	payload   = uvarint(key_epoch) || nonce(12) || AES-256-GCM_seal(room_key[epoch], nonce, plaintext, aad)
//	plaintext = det-CBOR(<type payload map>)          // §3
//	aad       = sender_pub || room_id || ts(le64) || uint16(type)
//
// key_epoch = 0 means "not room-encrypted" (identity/room-state events carry
// their own scheme); this package handles the encrypted case (epoch ≥ 1).
package room

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"

	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// KeySize is the AES-256 room-key length.
const KeySize = 32

// NonceSize is the AES-GCM nonce length.
const NonceSize = 12

var (
	ErrKeySize      = errors.New("room: room key must be 32 bytes")
	ErrShortFrame   = errors.New("room: payload frame too short")
	ErrNotEncrypted = errors.New("room: payload is not room-encrypted (epoch 0)")
)

// NewRoomKey generates a fresh random 32-byte room key.
func NewRoomKey() ([]byte, error) {
	k := make([]byte, KeySize)
	if _, err := rand.Read(k); err != nil {
		return nil, fmt.Errorf("room: gen key: %w", err)
	}
	return k, nil
}

// AAD builds the additional authenticated data binding the ciphertext to the
// envelope fields it belongs with: sender_pub || room_id || ts(le64) ||
// uint16(type). It uses only pre-hash fields, so there is no circularity with
// event_id (PROTOCOL.md §2.2).
func AAD(senderPub, roomID []byte, ts int64, typ cairnv1.EventType) []byte {
	aad := make([]byte, 0, len(senderPub)+len(roomID)+8+2)
	aad = append(aad, senderPub...)
	aad = append(aad, roomID...)
	var ts8 [8]byte
	binary.LittleEndian.PutUint64(ts8[:], uint64(ts))
	aad = append(aad, ts8[:]...)
	var t2 [2]byte
	binary.LittleEndian.PutUint16(t2[:], uint16(typ))
	aad = append(aad, t2[:]...)
	return aad
}

// Seal encrypts plaintext under roomKey[epoch] and returns the framed payload
// ready to place in Event.payload. epoch must be ≥ 1.
func Seal(roomKey []byte, epoch uint64, senderPub, roomID []byte, ts int64, typ cairnv1.EventType, plaintext []byte) ([]byte, error) {
	if len(roomKey) != KeySize {
		return nil, ErrKeySize
	}
	if epoch == 0 {
		return nil, ErrNotEncrypted
	}
	gcm, err := newGCM(roomKey)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, NonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("room: gen nonce: %w", err)
	}
	aad := AAD(senderPub, roomID, ts, typ)
	ct := gcm.Seal(nil, nonce, plaintext, aad)

	var epochBuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(epochBuf[:], epoch)

	out := make([]byte, 0, n+NonceSize+len(ct))
	out = append(out, epochBuf[:n]...)
	out = append(out, nonce...)
	out = append(out, ct...)
	return out, nil
}

// Open decrypts a framed payload from ev using roomKey. It reconstructs the AAD
// from ev's own envelope fields, so a payload whose framing was moved onto a
// different event will fail authentication.
func Open(roomKey []byte, ev *cairnv1.Event) (epoch uint64, plaintext []byte, err error) {
	if len(roomKey) != KeySize {
		return 0, nil, ErrKeySize
	}
	epoch, rest, err := splitFrame(ev.Payload)
	if err != nil {
		return 0, nil, err
	}
	if epoch == 0 {
		return 0, nil, ErrNotEncrypted
	}
	nonce := rest[:NonceSize]
	ct := rest[NonceSize:]
	gcm, err := newGCM(roomKey)
	if err != nil {
		return 0, nil, err
	}
	aad := AAD(ev.SenderPub, ev.RoomId, ev.Ts, ev.Type)
	pt, err := gcm.Open(nil, nonce, ct, aad)
	if err != nil {
		return 0, nil, fmt.Errorf("room: decrypt: %w", err)
	}
	return epoch, pt, nil
}

// PayloadEpoch reports the key_epoch a framed payload names without decrypting,
// so a receiver can pick the right key (or recognize epoch 0 = cleartext).
func PayloadEpoch(payload []byte) (uint64, error) {
	epoch, _, err := splitFrame(payload)
	return epoch, err
}

// FrameCleartext frames an unencrypted payload as key_epoch 0 (uvarint(0)||cbor),
// used by member_add/room_key_rotate and identity events whose payloads carry
// their own key material in cleartext-CBOR (PROTOCOL.md §2.2).
func FrameCleartext(cbor []byte) []byte {
	return append([]byte{0x00}, cbor...) // uvarint(0) is a single 0x00 byte
}

// Cleartext returns the cleartext CBOR of an epoch-0 event payload.
func Cleartext(ev *cairnv1.Event) ([]byte, error) {
	epoch, rest, err := splitFrame(ev.Payload)
	if err != nil {
		return nil, err
	}
	if epoch != 0 {
		return nil, fmt.Errorf("room: expected cleartext (epoch 0), got epoch %d", epoch)
	}
	return rest, nil
}

func splitFrame(payload []byte) (epoch uint64, rest []byte, err error) {
	epoch, n := binary.Uvarint(payload)
	if n <= 0 {
		return 0, nil, ErrShortFrame
	}
	rest = payload[n:]
	if epoch != 0 && len(rest) < NonceSize {
		return 0, nil, ErrShortFrame
	}
	return epoch, rest, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("room: aes: %w", err)
	}
	return cipher.NewGCM(block)
}
