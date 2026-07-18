package room

import (
	"github.com/fxamacker/cbor/v2"

	"github.com/geekgonecrazy/cairn/identity"
)

// Payload CBOR schemas (PROTOCOL.md §3). These are the plaintext maps that get
// deterministic-CBOR encoded, then sealed under the room key. Cross-impl byte
// identity is NOT required for payloads (each side encodes its own and decodes
// the other's) — only the event content tuple must match across Go/TS. Struct
// CBOR keys are the string names from PROTOCOL.md.

// Quote is an inline quotation of another message.
type Quote struct {
	Text        string `cbor:"text"`
	Author      []byte `cbor:"author"`
	SourceEvent []byte `cbor:"source_event"`
	SourceRoom  []byte `cbor:"source_room,omitempty"`
	Ts          int64  `cbor:"ts"`
}

// Chat is a text message, optionally a reply and/or a quote.
type Chat struct {
	Text    string `cbor:"text"`
	ReplyTo []byte `cbor:"reply_to,omitempty"`
	Quote   *Quote `cbor:"quote,omitempty"`
}

// Reaction carries the sender's COMPLETE current emoji set for a target; latest
// per (sender_root, target) wins (CRDT). An empty set clears the reaction.
type Reaction struct {
	Target []byte   `cbor:"target"`
	Emoji  []string `cbor:"emoji"`
}

// Edit supersedes an author's own earlier message. For chat the superseding
// content is just the new text; author-only (sender resolves to the target's
// member root). Original event_id is permanent; edit history is append-only.
type Edit struct {
	Target []byte `cbor:"target"`
	Text   string `cbor:"text"`
}

// Delete withdraws a message (author or admin). Not cryptographic erasure — the
// UI must say so; it renders as a withdrawal/tombstone.
type Delete struct {
	Target []byte `cbor:"target"`
	By     string `cbor:"by"` // "author" | "admin"
}

// Presence is ephemeral online state (not folded into history views).
type Presence struct {
	State string `cbor:"state"` // "online" | "away"
	Via   string `cbor:"via,omitempty"`
}

// EncodePayload deterministic-CBOR encodes a payload map (the plaintext to seal).
func EncodePayload(v any) ([]byte, error) { return identity.Marshal(v) }

// DecodeChat / DecodeReaction / … decode a decrypted plaintext into its struct.
func DecodeChat(b []byte) (*Chat, error) {
	var c Chat
	if err := cbor.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func DecodeReaction(b []byte) (*Reaction, error) {
	var r Reaction
	if err := cbor.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func DecodeDelete(b []byte) (*Delete, error) {
	var d Delete
	if err := cbor.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

func DecodeEdit(b []byte) (*Edit, error) {
	var e Edit
	if err := cbor.Unmarshal(b, &e); err != nil {
		return nil, err
	}
	return &e, nil
}
